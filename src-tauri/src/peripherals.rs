#![cfg(any(all(windows, not(feature = "win7")), target_os = "macos"))]

use crate::input_hook::InputEvent;
use gilrs::{Axis, Button, EventType, GamepadId, Gilrs};
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// Frontend event ids are stable and independent of backend enum ordering.
// 0 South/A, 1 East/B, 2 North/Y, 3 West/X, 4 LT, 5 LB, 6 RT, 7 RB,
// 8 Select/View, 9 Start/Menu, 10 Guide/Mode, 11 L3, 12 R3,
// 13..16 D-pad up/down/left/right, 17 Share, 19..22 paddles.
const PAD_BUTTON_SLOTS: usize = 24;
const PAD_AXIS_SLOTS: usize = 8;
const IDLE_SLEEP: Duration = Duration::from_millis(8);

pub fn start_gamepad_listener(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("kurocat-gamepad-gilrs".to_string())
        .spawn(move || run(app));
}

fn run(app: AppHandle) {
    // Windows uses gilrs' XInput backend. The WGI backend enumerates an empty
    // RawGameController collection on some Windows 11 systems, so it only ever
    // delivered Connected announcements and never button/axis updates. XInput
    // polls the stable Xbox controller slots directly and keeps delivering
    // input while KuroCat is in the background.
    let mut gilrs = match Gilrs::new() {
        Ok(gilrs) => gilrs,
        Err(_) => return,
    };

    // gilrs does not guarantee replaying Connected for gamepads that were
    // already present when the backend started.
    let mut announced = HashSet::new();
    for (id, gamepad) in gilrs.gamepads() {
        announce(&app, &mut announced, id, gamepad.name());
    }

    loop {
        let Some(event) = gilrs.next_event() else {
            std::thread::sleep(IDLE_SLEEP);
            continue;
        };

        let id = usize::from(event.id) as u32;
        match event.event {
            EventType::Connected => {
                let name = gilrs.gamepad(event.id).name().to_string();
                announce(&app, &mut announced, event.id, &name);
            }
            EventType::Disconnected => {
                announced.remove(&id);
                let _ = app.emit("kuro-input", InputEvent::GamepadDisconnected { id });
            }
            EventType::ButtonPressed(button, _) => {
                emit_button(&app, id, button, 1.0, true);
            }
            EventType::ButtonReleased(button, _) => {
                emit_button(&app, id, button, 0.0, false);
            }
            EventType::ButtonChanged(button, value, _) => {
                let value = value.clamp(0.0, 1.0);
                emit_button(&app, id, button, value, value > 0.5);
            }
            EventType::AxisChanged(axis, value, _) => {
                if let Some(axis) = axis_id(axis).filter(|axis| *axis < PAD_AXIS_SLOTS as u32) {
                    let _ = app.emit(
                        "kuro-input",
                        InputEvent::GamepadAxis {
                            id,
                            axis,
                            value: normalize_axis_value(axis, value.clamp(-1.0, 1.0)),
                        },
                    );
                }
            }
            _ => {}
        }
    }
}

/// The frontend draws stick movement with screen coordinates, so "up" has to be
/// negative on the Y axis. gilrs' WGI (Windows) and macOS backends already
/// report it that way, but the XInput backend reports "up" as positive.
/// Normalize here so every platform agrees with the frontend contract.
#[cfg(windows)]
fn normalize_axis_value(axis: u32, value: f32) -> f32 {
    match axis {
        1 | 3 | 7 => -value,
        _ => value,
    }
}

#[cfg(not(windows))]
fn normalize_axis_value(_axis: u32, value: f32) -> f32 {
    value
}

fn announce(app: &AppHandle, announced: &mut HashSet<u32>, id: GamepadId, name: &str) {
    let id = usize::from(id) as u32;
    if !announced.insert(id) {
        return;
    }
    let _ = app.emit(
        "kuro-input",
        InputEvent::GamepadConnected {
            id,
            name: name.to_string(),
        },
    );
}

fn emit_button(app: &AppHandle, id: u32, button: Button, value: f32, pressed: bool) {
    // Sharing the same frontend ids as the old WinRT path keeps the existing
    // bubbles, paw anchors and highlight slots working unchanged.
    let Some(button) = button_id(button) else {
        return;
    };
    if button as usize >= PAD_BUTTON_SLOTS {
        return;
    }
    let _ = app.emit(
        "kuro-input",
        InputEvent::GamepadButton {
            id,
            button,
            pressed,
            value: value.clamp(0.0, 1.0),
        },
    );
}

fn button_id(button: Button) -> Option<u32> {
    Some(match button {
        Button::South => 0,
        Button::East => 1,
        Button::North => 2,
        Button::West => 3,
        // gilrs names the analog bottom triggers *2; the un-suffixed buttons
        // are the digital shoulder bumpers.
        Button::LeftTrigger2 => 4,
        Button::LeftTrigger => 5,
        Button::RightTrigger2 => 6,
        Button::RightTrigger => 7,
        Button::Select => 8,
        Button::Start => 9,
        Button::Mode => 10,
        Button::LeftThumb => 11,
        Button::RightThumb => 12,
        Button::DPadUp => 13,
        Button::DPadDown => 14,
        Button::DPadLeft => 15,
        Button::DPadRight => 16,
        _ => return None,
    })
}

fn axis_id(axis: Axis) -> Option<u32> {
    Some(match axis {
        Axis::LeftStickX => 0,
        Axis::LeftStickY => 1,
        Axis::RightStickX => 2,
        Axis::RightStickY => 3,
        Axis::LeftZ => 4,
        Axis::RightZ => 5,
        Axis::DPadX => 6,
        Axis::DPadY => 7,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_face_shoulder_and_menu_buttons() {
        assert_eq!(button_id(Button::South), Some(0));
        assert_eq!(button_id(Button::East), Some(1));
        assert_eq!(button_id(Button::North), Some(2));
        assert_eq!(button_id(Button::West), Some(3));
        assert_eq!(button_id(Button::LeftTrigger), Some(5));
        assert_eq!(button_id(Button::RightTrigger), Some(7));
        assert_eq!(button_id(Button::Select), Some(8));
        assert_eq!(button_id(Button::Start), Some(9));
        assert_eq!(button_id(Button::Mode), Some(10));
        assert_eq!(button_id(Button::LeftThumb), Some(11));
        assert_eq!(button_id(Button::RightThumb), Some(12));
        assert_eq!(button_id(Button::DPadUp), Some(13));
        assert_eq!(button_id(Button::DPadDown), Some(14));
        assert_eq!(button_id(Button::DPadLeft), Some(15));
        assert_eq!(button_id(Button::DPadRight), Some(16));
    }

    #[test]
    fn maps_analog_triggers_to_trigger_slots() {
        assert_eq!(button_id(Button::LeftTrigger2), Some(4));
        assert_eq!(button_id(Button::RightTrigger2), Some(6));
    }

    #[test]
    fn maps_sticks_and_triggers_to_frontend_axes() {
        assert_eq!(axis_id(Axis::LeftStickX), Some(0));
        assert_eq!(axis_id(Axis::LeftStickY), Some(1));
        assert_eq!(axis_id(Axis::RightStickX), Some(2));
        assert_eq!(axis_id(Axis::RightStickY), Some(3));
        assert_eq!(axis_id(Axis::LeftZ), Some(4));
        assert_eq!(axis_id(Axis::RightZ), Some(5));
        assert_eq!(axis_id(Axis::DPadX), Some(6));
        assert_eq!(axis_id(Axis::DPadY), Some(7));
    }

    #[test]
    fn keeps_stick_up_direction_negative() {
        // The frontend mirrors the model vertically, so "stick pushed up" must
        // stay negative on the Y axes regardless of the backend convention.
        assert_eq!(normalize_axis_value(1, 0.5), -0.5);
        assert_eq!(normalize_axis_value(3, 1.0), -1.0);
        assert_eq!(normalize_axis_value(7, -0.25), 0.25);
        assert_eq!(normalize_axis_value(0, 0.5), 0.5);
        assert_eq!(normalize_axis_value(2, -0.75), -0.75);
    }
}
