#![cfg(windows)]

use crate::input_hook::InputEvent;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr;
use std::slice;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Devices::HumanInterfaceDevice::{
    HidP_GetButtonCaps, HidP_GetCaps, HidP_GetData, HidP_GetValueCaps, HidP_Input,
    HidP_MaxDataListLength, HIDP_BUTTON_CAPS, HIDP_CAPS, HIDP_DATA, HIDP_STATUS_SUCCESS,
    HIDP_VALUE_CAPS,
};
use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::{
    GetRawInputData, GetRawInputDeviceInfoW, GetRawInputDeviceList, RegisterRawInputDevices,
    RAWINPUT, RAWINPUTDEVICE, RAWINPUTDEVICELIST, RAWINPUTHEADER, RIDEV_DEVNOTIFY,
    RIDEV_INPUTSINK, RIDI_DEVICEINFO, RIDI_DEVICENAME, RIDI_PREPARSEDDATA, RID_INPUT, RIM_TYPEHID,
    RID_DEVICE_INFO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW,
    RegisterClassW, TranslateMessage, GIDC_ARRIVAL, GIDC_REMOVAL, HWND_MESSAGE,
    MWMO_INPUTAVAILABLE, MSG, PM_REMOVE, QS_ALLINPUT, WNDCLASSW, WM_INPUT,
    WM_INPUT_DEVICE_CHANGE,
};

const USAGE_PAGE_GENERIC_DESKTOP: u16 = 0x01;
const USAGE_PAGE_BUTTON: u16 = 0x09;
const USAGE_PAGE_DIGITIZER: u16 = 0x0d;
const USAGE_PAGE_WACOM_TABLET: u16 = 0xff00;
const USAGE_PAGE_WACOM_VENDOR: u16 = 0xff0d;
const WACOM_VENDOR_ID: u16 = 0x056a;
const WACOM_PEN_REPORT_ID: u8 = 0x10;
const WACOM_AUX_REPORT_ID: u8 = 0x11;
const WACOM_CTL_6100_MAX_X: f32 = 21600.0;
const WACOM_CTL_6100_MAX_Y: f32 = 13500.0;
const WACOM_CTL_6100_MAX_PRESSURE: f32 = 4095.0;
// The pen sample is the one thing the user judges by latency: every
// millisecond the nib is late shows up next to the real stroke in Photoshop.
// Wacom pens report at roughly 130 Hz, but every forwarded sample costs an
// IPC round trip and a webview frame. A 10 ms slot still lands about 100
// samples per second and takes a third of the pressure off the renderer.
const PEN_EMIT_INTERVAL: Duration = Duration::from_millis(10);
// A pen that is resting in range still needs a slow heartbeat, otherwise the
// frontend's 1.2 s stale-pen release would drop it while it is still hovering.
const PEN_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(500);
// A hovering pen jitters by a fraction of a millimetre. Without a dead zone
// the sampler would forward that noise to the webview as a continuous stream
// of events and starve the renderer.
const PEN_MOVE_EPSILON: f32 = 1.0 / 512.0;
// The nib's range state is latched: as soon as any of the proximity signals
// fires the pen counts as being on the tablet and it stays there until the
// reports go quiet. Firmware generations disagree about the status byte and a
// single report can drop it, which used to make the nib blink out of
// existence in the middle of a stroke.
const PEN_QUIET_RELEASE: Duration = Duration::from_millis(1500);
// Windows mirrors the pen into the OS mouse pointer. While the nib is down
// those synthetic moves only duplicate the pen stream, so the mouse hook
// drops them instead of queueing thousands of them.
const PEN_MOUSE_SUPPRESS_WINDOW: Duration = Duration::from_millis(400);
// While the nib is down the drawing application is the only thing that
// matters. The global hooks are paused for that time so Photoshop / CSP get
// the untouched input path. The pause runs on a deadline, so a lost pen
// report can never switch the hooks off for good.
const PEN_DRAWING_PAUSE_WINDOW: Duration = Duration::from_millis(400);

/// Latched "is the pen on the tablet" state.
#[derive(Debug, Default)]
struct PenRange {
    latched: bool,
    quiet_since: Option<Instant>,
}

impl PenRange {
    /// Feeds one report's raw proximity evidence into the latch and returns
    /// the range state that has to be published for that report.
    fn observe(&mut self, signal: bool, now: Instant) -> bool {
        if signal {
            self.latched = true;
            self.quiet_since = None;
            return true;
        }
        if !self.latched {
            return false;
        }
        let since = *self.quiet_since.get_or_insert(now);
        let quiet = now.checked_duration_since(since).unwrap_or_default();
        if quiet >= PEN_QUIET_RELEASE {
            self.latched = false;
            self.quiet_since = None;
            return false;
        }
        true
    }
}

pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("kurocat-tablet-raw-input".to_string())
        .spawn(move || run(app));
}

#[derive(Clone)]
struct DeviceMeta {
    path: String,
    name: String,
    vendor_id: u16,
    usage_page: u16,
    usage: u16,
}

type DataKey = (u8, u16);

#[derive(Clone, Copy)]
struct ValueInfo {
    report_id: u8,
    usage_page: u16,
    usage: u16,
    logical_min: i32,
    logical_max: i32,
    is_absolute: bool,
}

#[derive(Clone, Copy)]
struct ButtonInfo {
    report_id: u8,
    usage_page: u16,
    usage: u16,
}

#[derive(Clone, Copy, Default, PartialEq)]
struct PenSample {
    nx: f32,
    ny: f32,
    pressure: f32,
    tilt_x: f32,
    tilt_y: f32,
    tip: bool,
    barrel: bool,
    second_barrel: bool,
    eraser: bool,
    in_range: bool,
}

struct HidDevice {
    meta: DeviceMeta,
    preparsed: Vec<u8>,
    caps: HIDP_CAPS,
    values: HashMap<DataKey, ValueInfo>,
    buttons: HashMap<DataKey, ButtonInfo>,
    last_x: f32,
    last_y: f32,
    last_raw_x: u32,
    last_raw_y: u32,
    last_tilt_x: f32,
    last_tilt_y: f32,
    last_pressure: f32,
    range: PenRange,
    last_sample: Option<PenSample>,
    pending_sample: Option<PenSample>,
    /// Whether the nib touched the surface in the last forwarded sample.
    pen_tip_down: bool,
    last_emit: Instant,
    max_data_len: usize,
    entries: Vec<HIDP_DATA>,
    known_reports: HashSet<u8>,
    pen_reports: HashSet<u8>,
    range_reports: HashSet<u8>,
    aux_buttons: u32,
    wacom_max_x: f32,
    wacom_max_y: f32,
    wacom_max_pressure: f32,
}

struct TabletContext {
    app: AppHandle,
    devices: HashMap<usize, HidDevice>,
    paths: HashMap<usize, String>,
    connected: HashSet<String>,
    /// Whether the global hooks are currently paused because the nib is down.
    drawing_pause_active: bool,
}

unsafe extern "system" fn tablet_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn run(app: AppHandle) {
    let class_name: Vec<u16> = "KuroCatTabletRawInput\0".encode_utf16().collect();
    let title: Vec<u16> = "KuroCat Tablet Input\0".encode_utf16().collect();

    unsafe {
        let hinst = GetModuleHandleW(ptr::null());
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(tablet_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: ptr::null_mut(),
            hCursor: ptr::null_mut(),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        let _ = RegisterClassW(&window_class);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            hinst,
            ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }

        if !register_tablet_raw_input(hwnd) {
            return;
        }
    }

    let mut context = TabletContext {
        app,
        devices: HashMap::new(),
        paths: HashMap::new(),
        connected: HashSet::new(),
        drawing_pause_active: false,
    };
    scan_initial_devices(&mut context);

    let mut msg: MSG = unsafe { zeroed() };
    loop {
        // Wacom drivers often pack several reports into one WM_INPUT packet,
        // and Windows may queue several packets while the UI is busy. Drain the
        // queue and coalesce pens to the newest sample instead of serializing
        // every report into a separate IPC event.
        while unsafe { PeekMessageW(&mut msg, ptr::null_mut(), 0, 0, PM_REMOVE) } > 0 {
            match msg.message {
                WM_INPUT => handle_raw_input(&mut context, msg.lParam),
                WM_INPUT_DEVICE_CHANGE => {
                    handle_device_change(&mut context, msg.wParam as u32, msg.lParam as HANDLE)
                }
                _ => {}
            }
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            flush_pending_pens(&mut context);
        }
        flush_pending_pens(&mut context);

        // Only wake on a timer while a coalesced sample is still waiting for
        // the next frame-sized emission slot. Idle tablets stay fully asleep.
        let timeout = pending_pen_timeout(&context)
            .map(|duration| duration.as_millis().max(1) as u32)
            .unwrap_or(u32::MAX);
        unsafe {
            MsgWaitForMultipleObjectsEx(
                0,
                ptr::null(),
                timeout,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            );
        }
    }
}

fn register_tablet_raw_input(hwnd: HWND) -> bool {
    const TARGETS: &[(u16, u16)] = &[
        (USAGE_PAGE_DIGITIZER, 0x01),
        (USAGE_PAGE_DIGITIZER, 0x02),
        (USAGE_PAGE_DIGITIZER, 0x03),
        (USAGE_PAGE_WACOM_TABLET, 0x0a),
        (USAGE_PAGE_WACOM_VENDOR, 0x01),
    ];

    let register = |extra_flags: u32| {
        let devices = TARGETS
            .iter()
            .map(|(usage_page, usage)| RAWINPUTDEVICE {
                usUsagePage: *usage_page,
                usUsage: *usage,
                dwFlags: RIDEV_INPUTSINK | extra_flags,
                hwndTarget: hwnd,
            })
            .collect::<Vec<_>>();
        !devices.is_empty()
            && unsafe {
                RegisterRawInputDevices(
                    devices.as_ptr(),
                    devices.len() as u32,
                    size_of::<RAWINPUTDEVICE>() as u32,
                ) != 0
            }
    };

    register(RIDEV_DEVNOTIFY) || register(0)
}

fn scan_initial_devices(context: &mut TabletContext) {
    for hdevice in list_hid_devices() {
        let Some(meta) = query_device_meta(hdevice) else {
            continue;
        };
        if !is_tablet(&meta) {
            continue;
        }
        context.paths.insert(hdevice as usize, meta.path.clone());
        emit_connected(context, &meta);
    }
}

fn handle_device_change(context: &mut TabletContext, event: u32, hdevice: HANDLE) {
    let key = hdevice as usize;
    if event == GIDC_ARRIVAL {
        if !context.devices.contains_key(&key) {
            let Some(meta) = query_device_meta(hdevice) else {
                return;
            };
            if !is_tablet(&meta) {
                return;
            }
            context.paths.insert(key, meta.path.clone());
            emit_connected(context, &meta);
        }
    } else if event == GIDC_REMOVAL {
        if let Some(path) = context.paths.remove(&key) {
            context.devices.remove(&key);
            let still_present = context.paths.values().any(|known| known == &path);
            if !still_present && context.connected.remove(&path) {
                let _ = context
                    .app
                    .emit("kuro-input", InputEvent::TabletDisconnected);
            }
        }
    }
}

fn emit_connected(context: &mut TabletContext, meta: &DeviceMeta) {
    if !context.connected.insert(meta.path.clone()) {
        return;
    }
    let _ = context.app.emit(
        "kuro-input",
        InputEvent::TabletConnected {
            name: meta.name.clone(),
        },
    );
}

struct RawHidPacket<'a> {
    device: HANDLE,
    report_size: usize,
    report_count: usize,
    reports: &'a [u8],
}

fn handle_raw_input(context: &mut TabletContext, lparam: isize) {
    let Some((buffer, bytes_written)) = read_raw_input(lparam) else {
        return;
    };
    let Some(packet) = raw_hid_packet(&buffer, bytes_written) else {
        return;
    };
    let key = packet.device as usize;
    if !context.devices.contains_key(&key) {
        let Some(meta) = query_device_meta(packet.device) else {
            return;
        };
        if !is_tablet(&meta) {
            return;
        }
        let Some(device) = build_hid_device(packet.device, meta.clone()) else {
            return;
        };
        context.paths.insert(key, meta.path.clone());
        emit_connected(context, &meta);
        context.devices.insert(key, device);
    }

    let app = context.app.clone();
    if let Some(device) = context.devices.get_mut(&key) {
        // Reuse the HIDP_DATA scratch buffer across packets. Wacom's vendor
        // reports never need it, and allocating it on every WM_INPUT packet
        // adds avoidable pressure on low-power tablets.
        let mut entries = std::mem::take(&mut device.entries);
        for index in 0..packet.report_count {
            let start = index * packet.report_size;
            let end = start + packet.report_size;
            process_report(device, &app, &packet.reports[start..end], &mut entries);
        }
        device.entries = entries;
        flush_pen(device, &app);
    }
}

fn raw_hid_packet(buffer: &[usize], bytes_written: usize) -> Option<RawHidPacket<'_>> {
    let header_size = size_of::<RAWINPUTHEADER>();
    let hid_header_size = size_of::<u32>() * 2;
    let fixed_size = header_size.checked_add(hid_header_size)?;
    let buffer_size = buffer.len().checked_mul(size_of::<usize>())?;
    if bytes_written < fixed_size || bytes_written > buffer_size {
        return None;
    }

    let raw_input = unsafe { &*(buffer.as_ptr() as *const RAWINPUT) };
    if raw_input.header.dwType != RIM_TYPEHID {
        return None;
    }

    // RAWHID is #[repr(C)] with bRawData inline. It must be borrowed from the
    // original Raw Input buffer; copying RAWHID to the stack makes bRawData
    // point at a one-byte stack slot and reading a full HID packet from there
    // is undefined behaviour. That bug made Wacom pens freeze or jump.
    let hid = unsafe { &raw_input.data.hid };
    let report_size = hid.dwSizeHid as usize;
    let report_count = hid.dwCount as usize;
    let data_len = report_size.checked_mul(report_count)?;
    if data_len == 0 || data_len > bytes_written - fixed_size {
        return None;
    }

    let reports = unsafe { slice::from_raw_parts(hid.bRawData.as_ptr(), data_len) };
    Some(RawHidPacket {
        device: raw_input.header.hDevice,
        report_size,
        report_count,
        reports,
    })
}

fn read_raw_input(lparam: isize) -> Option<(Vec<usize>, usize)> {
    let mut size = 0u32;
    let header_size = size_of::<RAWINPUTHEADER>() as u32;
    let first = unsafe {
        GetRawInputData(
            lparam as _,
            RID_INPUT,
            ptr::null_mut(),
            &mut size,
            header_size,
        )
    };
    if first == u32::MAX || size == 0 {
        return None;
    }

    let words = (size as usize + size_of::<usize>() - 1) / size_of::<usize>();
    let mut buffer = vec![0usize; words.max(1)];
    let written = unsafe {
        GetRawInputData(
            lparam as _,
            RID_INPUT,
            buffer.as_mut_ptr() as *mut c_void,
            &mut size,
            header_size,
        )
    };
    if written == u32::MAX || written == 0 {
        return None;
    }
    Some((buffer, written as usize))
}

fn list_hid_devices() -> Vec<HANDLE> {
    let item_size = size_of::<RAWINPUTDEVICELIST>() as u32;
    let mut count = 0u32;
    let result =
        unsafe { GetRawInputDeviceList(ptr::null_mut(), &mut count, item_size) };
    if result == u32::MAX || count == 0 {
        return Vec::new();
    }

    let mut list = vec![
        RAWINPUTDEVICELIST {
            hDevice: ptr::null_mut(),
            dwType: 0,
        };
        count as usize
    ];
    let mut written = count;
    let result = unsafe { GetRawInputDeviceList(list.as_mut_ptr(), &mut written, item_size) };
    if result == u32::MAX {
        return Vec::new();
    }
    list.truncate(written as usize);
    list.into_iter()
        .filter(|item| item.dwType == RIM_TYPEHID)
        .map(|item| item.hDevice)
        .collect()
}

fn query_device_meta(hdevice: HANDLE) -> Option<DeviceMeta> {
    let path = query_device_name(hdevice);
    let info = query_device_info(hdevice);
    let vendor_id = info
        .map(|value| value.dwVendorId as u16)
        .unwrap_or_else(|| parse_vid_pid(&path).0);
    let product_id = info
        .map(|value| value.dwProductId as u16)
        .unwrap_or_else(|| parse_vid_pid(&path).1);
    let usage_page = info.map(|value| value.usUsagePage).unwrap_or(0);
    let usage = info.map(|value| value.usUsage).unwrap_or(0);
    let is_wacom = vendor_id == WACOM_VENDOR_ID || path.to_ascii_lowercase().contains("vid_056a");
    let name = if is_wacom {
        if matches!(product_id, 0x0375 | 0x0378) {
            "Wacom CTL-6100".to_string()
        } else {
            "Wacom 数位板".to_string()
        }
    } else {
        "数位板".to_string()
    };
    Some(DeviceMeta {
        path,
        name,
        vendor_id,
        usage_page,
        usage,
    })
}

fn query_device_name(hdevice: HANDLE) -> String {
    let mut size = 0u32;
    let first = unsafe {
        GetRawInputDeviceInfoW(
            hdevice,
            RIDI_DEVICENAME,
            ptr::null_mut(),
            &mut size,
        )
    };
    if first == u32::MAX || size == 0 {
        return String::new();
    }

    let mut buffer = vec![0u16; size as usize + 1];
    let mut written = buffer.len() as u32;
    let result = unsafe {
        GetRawInputDeviceInfoW(
            hdevice,
            RIDI_DEVICENAME,
            buffer.as_mut_ptr() as *mut c_void,
            &mut written,
        )
    };
    if result == u32::MAX {
        return String::new();
    }
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(written as usize);
    String::from_utf16_lossy(&buffer[..length.min(buffer.len())])
}

fn query_device_info(hdevice: HANDLE) -> Option<windows_sys::Win32::UI::Input::RID_DEVICE_INFO_HID> {
    let mut info: RID_DEVICE_INFO = unsafe { zeroed() };
    info.cbSize = size_of::<RID_DEVICE_INFO>() as u32;
    let mut size = info.cbSize;
    let result = unsafe {
        GetRawInputDeviceInfoW(
            hdevice,
            RIDI_DEVICEINFO,
            &mut info as *mut _ as *mut c_void,
            &mut size,
        )
    };
    if result == u32::MAX {
        None
    } else {
        Some(unsafe { info.Anonymous.hid })
    }
}

fn parse_vid_pid(path: &str) -> (u16, u16) {
    let lower = path.to_ascii_lowercase();
    let vid = lower
        .split("vid_")
        .nth(1)
        .and_then(|tail| tail.get(..4))
        .and_then(|value| u16::from_str_radix(value, 16).ok())
        .unwrap_or(0);
    let pid = lower
        .split("pid_")
        .nth(1)
        .and_then(|tail| tail.get(..4))
        .and_then(|value| u16::from_str_radix(value, 16).ok())
        .unwrap_or(0);
    (vid, pid)
}

fn is_tablet(meta: &DeviceMeta) -> bool {
    if meta.vendor_id == WACOM_VENDOR_ID {
        return matches!(
            (meta.usage_page, meta.usage),
            (USAGE_PAGE_DIGITIZER, 0x01)
                | (USAGE_PAGE_DIGITIZER, 0x02)
                | (USAGE_PAGE_WACOM_TABLET, 0x0a)
                | (USAGE_PAGE_WACOM_VENDOR, 0x01)
        );
    }
    meta.usage_page == USAGE_PAGE_DIGITIZER && matches!(meta.usage, 0x01 | 0x02 | 0x03)
}

fn build_hid_device(hdevice: HANDLE, meta: DeviceMeta) -> Option<HidDevice> {
    let mut preparsed_size = 0u32;
    let first = unsafe {
        GetRawInputDeviceInfoW(
            hdevice,
            RIDI_PREPARSEDDATA,
            ptr::null_mut(),
            &mut preparsed_size,
        )
    };
    if first == u32::MAX || preparsed_size == 0 {
        return None;
    }

    let mut preparsed = vec![0u8; preparsed_size as usize];
    let mut written = preparsed_size;
    let result = unsafe {
        GetRawInputDeviceInfoW(
            hdevice,
            RIDI_PREPARSEDDATA,
            preparsed.as_mut_ptr() as *mut c_void,
            &mut written,
        )
    };
    if result == u32::MAX {
        return None;
    }
    preparsed.truncate(written as usize);

    let preparsed_ptr = preparsed.as_mut_ptr() as isize;
    let mut caps: HIDP_CAPS = unsafe { zeroed() };
    if unsafe { HidP_GetCaps(preparsed_ptr, &mut caps) } != HIDP_STATUS_SUCCESS {
        return None;
    }

    let values = read_value_caps(preparsed_ptr, &caps);
    let buttons = read_button_caps(preparsed_ptr, &caps);
    let mut known_reports = HashSet::new();
    let mut pen_reports = HashSet::new();
    let mut range_reports = HashSet::new();
    for info in values.values() {
        known_reports.insert(info.report_id);
        if is_pen_value_usage(*info) {
            pen_reports.insert(info.report_id);
        }
        if info.usage_page == USAGE_PAGE_DIGITIZER && info.usage == 0x50 {
            range_reports.insert(info.report_id);
        }
    }
    for info in buttons.values() {
        known_reports.insert(info.report_id);
        if is_pen_button_usage(*info) {
            pen_reports.insert(info.report_id);
        }
        if info.usage_page == USAGE_PAGE_DIGITIZER && info.usage == 0x50 {
            range_reports.insert(info.report_id);
        }
    }
    let max_data_len =
        unsafe { HidP_MaxDataListLength(HidP_Input, preparsed.as_mut_ptr() as isize) }.max(8)
            as usize;
    let (wacom_max_x, wacom_max_y, wacom_max_pressure) =
        if meta.vendor_id == WACOM_VENDOR_ID && meta.usage_page == USAGE_PAGE_DIGITIZER {
            infer_wacom_pen_limits(&values)
        } else {
            (
                WACOM_CTL_6100_MAX_X,
                WACOM_CTL_6100_MAX_Y,
                WACOM_CTL_6100_MAX_PRESSURE,
            )
        };
    Some(HidDevice {
        meta,
        preparsed,
        caps,
        values,
        buttons,
        last_x: 0.5,
        last_y: 0.5,
        last_raw_x: 0,
        last_raw_y: 0,
        last_tilt_x: 0.0,
        last_tilt_y: 0.0,
        last_pressure: 0.0,
        range: PenRange::default(),
        last_sample: None,
        pending_sample: None,
        pen_tip_down: false,
        last_emit: Instant::now() - Duration::from_secs(1),
        max_data_len,
        entries: vec![unsafe { zeroed::<HIDP_DATA>() }; max_data_len],
        known_reports,
        pen_reports,
        range_reports,
        aux_buttons: 0,
        wacom_max_x,
        wacom_max_y,
        wacom_max_pressure,
    })
}

fn infer_wacom_pen_limits(values: &HashMap<DataKey, ValueInfo>) -> (f32, f32, f32) {
    let mut max_x = 0.0_f32;
    let mut max_y = 0.0_f32;
    let mut max_pressure = 0.0_f32;
    for info in values.values() {
        if !info.is_absolute || info.logical_max <= 1 {
            continue;
        }
        let logical_max = info.logical_max as f32;
        match (info.usage_page, info.usage) {
            (USAGE_PAGE_GENERIC_DESKTOP, 0x30) => max_x = max_x.max(logical_max),
            (USAGE_PAGE_GENERIC_DESKTOP, 0x31) => max_y = max_y.max(logical_max),
            (USAGE_PAGE_DIGITIZER, 0x30) => max_pressure = max_pressure.max(logical_max),
            _ => {}
        }
    }
    (
        if max_x > 1.0 { max_x } else { WACOM_CTL_6100_MAX_X },
        if max_y > 1.0 { max_y } else { WACOM_CTL_6100_MAX_Y },
        if max_pressure > 1.0 {
            max_pressure
        } else {
            WACOM_CTL_6100_MAX_PRESSURE
        },
    )
}

fn read_value_caps(preparsed: isize, caps: &HIDP_CAPS) -> HashMap<DataKey, ValueInfo> {
    let mut map = HashMap::new();
    let count = caps.NumberInputValueCaps as usize;
    if count == 0 {
        return map;
    }
    let mut values = vec![unsafe { zeroed::<HIDP_VALUE_CAPS>() }; count];
    let mut length = count as u16;
    if unsafe { HidP_GetValueCaps(HidP_Input, values.as_mut_ptr(), &mut length, preparsed) }
        != HIDP_STATUS_SUCCESS
    {
        return map;
    }
    values.truncate(length as usize);
    for value in values {
        if value.IsRange != 0 {
            let range = unsafe { value.Anonymous.Range };
            let span = range.UsageMax.saturating_sub(range.UsageMin);
            for offset in 0..=span {
                map.insert(
                    (
                        value.ReportID,
                        range.DataIndexMin.saturating_add(offset),
                    ),
                    ValueInfo {
                        report_id: value.ReportID,
                        usage_page: value.UsagePage,
                        usage: range.UsageMin.saturating_add(offset),
                        logical_min: value.LogicalMin,
                        logical_max: value.LogicalMax,
                        is_absolute: value.IsAbsolute != 0,
                    },
                );
            }
        } else {
            let single = unsafe { value.Anonymous.NotRange };
            map.insert(
                (value.ReportID, single.DataIndex),
                ValueInfo {
                    report_id: value.ReportID,
                    usage_page: value.UsagePage,
                    usage: single.Usage,
                    logical_min: value.LogicalMin,
                    logical_max: value.LogicalMax,
                    is_absolute: value.IsAbsolute != 0,
                },
            );
        }
    }
    map
}

fn read_button_caps(preparsed: isize, caps: &HIDP_CAPS) -> HashMap<DataKey, ButtonInfo> {
    let mut map = HashMap::new();
    let count = caps.NumberInputButtonCaps as usize;
    if count == 0 {
        return map;
    }
    let mut buttons = vec![unsafe { zeroed::<HIDP_BUTTON_CAPS>() }; count];
    let mut length = count as u16;
    if unsafe { HidP_GetButtonCaps(HidP_Input, buttons.as_mut_ptr(), &mut length, preparsed) }
        != HIDP_STATUS_SUCCESS
    {
        return map;
    }
    buttons.truncate(length as usize);
    for button in buttons {
        if button.IsRange != 0 {
            let range = unsafe { button.Anonymous.Range };
            let span = range.UsageMax.saturating_sub(range.UsageMin);
            for offset in 0..=span {
                map.insert(
                    (
                        button.ReportID,
                        range.DataIndexMin.saturating_add(offset),
                    ),
                    ButtonInfo {
                        report_id: button.ReportID,
                        usage_page: button.UsagePage,
                        usage: range.UsageMin.saturating_add(offset),
                    },
                );
            }
        } else {
            let single = unsafe { button.Anonymous.NotRange };
            map.insert(
                (button.ReportID, single.DataIndex),
                ButtonInfo {
                    report_id: button.ReportID,
                    usage_page: button.UsagePage,
                    usage: single.Usage,
                },
            );
        }
    }
    map
}

fn process_report(
    device: &mut HidDevice,
    app: &AppHandle,
    report: &[u8],
    entries: &mut [HIDP_DATA],
) {
    if device.meta.vendor_id == WACOM_VENDOR_ID {
        if let Some(index) = find_report_id(report, WACOM_AUX_REPORT_ID) {
            if let Some(byte) = report.get(index + 1) {
                let mask = u32::from(byte & 0x0f);
                if mask != device.aux_buttons {
                    device.aux_buttons = mask;
                    let _ = app.emit("kuro-input", InputEvent::TabletKeys { buttons: mask });
                }
                return;
            }
        }
        if let Some(index) = find_report_id(report, WACOM_PEN_REPORT_ID) {
            if let Some(sample) = parse_wacom_pen(device, report, index) {
                device.pending_sample = Some(sample);
                return;
            }
        }
    }

    if let Some(sample) = parse_hid_pen(device, report, entries) {
        device.pending_sample = Some(sample);
    }
}

fn find_report_id(report: &[u8], id: u8) -> Option<usize> {
    // Wacom reports start with the report id. With the official driver the
    // Raw Input packet has one leading byte, so the id is at offset 1.
    // Scanning deeper can mistake coordinate bytes for a report id.
    if report.first() == Some(&id) {
        Some(0)
    } else if report.get(1) == Some(&id) {
        Some(1)
    } else {
        None
    }
}

fn parse_wacom_pen(device: &mut HidDevice, report: &[u8], index: usize) -> Option<PenSample> {
    if report.len() < index + 10 {
        return None;
    }
    let raw_buttons = report[index + 1];
    let buttons = raw_buttons & !0x01;
    let x = u32::from(report[index + 2])
        | (u32::from(report[index + 3]) << 8)
        | (u32::from(report[index + 4]) << 16);
    let y = u32::from(report[index + 5])
        | (u32::from(report[index + 6]) << 8)
        | (u32::from(report[index + 7]) << 16);
    let pressure = u32::from(report[index + 8]) | (u32::from(report[index + 9]) << 8);
    let pressure = (pressure as f32 / device.wacom_max_pressure.max(1.0)).clamp(0.0, 1.0);
    let tip = pressure > 0.002;
    let barrel = buttons & 0x02 != 0;
    let second_barrel = buttons & 0x04 != 0;
    let eraser = buttons & 0x08 != 0;

    // Wacom packs the whole tool state into a single byte and the firmware
    // generations disagree about which bit carries "in proximity". Deriving
    // the range state from every reliable signal instead of one bit keeps the
    // nib alive: a moved coordinate, a pressed button or any contact always
    // means the pen is on the tablet.
    let proximity = raw_buttons & 0x01 != 0 || buttons & 0x20 != 0;
    // Some drivers report the origin instead of the last position once the
    // pen leaves the tablet. A nib at the exact origin without pressure is
    // the only thing that tells that apart from a real stroke in the corner.
    let lost = x == 0 && y == 0 && pressure <= 0.002;
    let moved = !lost && (x != device.last_raw_x || y != device.last_raw_y);
    // Any single signal is enough to latch the nib onto the tablet. The latch
    // keeps a dropped status byte from blinking the pen away mid-stroke.
    let signal = !lost && (proximity || moved || tip || barrel || second_barrel || eraser);
    let in_range = device.range.observe(signal, Instant::now());

    // A latched report that reports the origin means the pen left the
    // tablet, so the last known position has to survive instead of the nib
    // jumping into the corner.
    if in_range && !lost {
        device.last_x = (x as f32 / device.wacom_max_x.max(1.0)).clamp(0.0, 1.0);
        device.last_y = (y as f32 / device.wacom_max_y.max(1.0)).clamp(0.0, 1.0);
        device.last_raw_x = x;
        device.last_raw_y = y;
    }
    device.last_pressure = if in_range { pressure } else { 0.0 };
    Some(PenSample {
        nx: device.last_x,
        ny: device.last_y,
        pressure: device.last_pressure,
        tilt_x: device.last_tilt_x,
        tilt_y: device.last_tilt_y,
        tip: tip && in_range,
        barrel,
        second_barrel,
        eraser,
        in_range,
    })
}

fn report_id_has_caps(device: &HidDevice, report_id: u8) -> bool {
    device.known_reports.contains(&report_id)
}

fn is_pen_value_usage(info: ValueInfo) -> bool {
    (info.usage_page == USAGE_PAGE_GENERIC_DESKTOP
        && info.is_absolute
        && matches!(info.usage, 0x30 | 0x31))
        || (info.usage_page == USAGE_PAGE_DIGITIZER
            && matches!(
                info.usage,
                0x30 | 0x3c | 0x3d | 0x3e | 0x42 | 0x43 | 0x44 | 0x45 | 0x50
            ))
}

fn is_pen_button_usage(info: ButtonInfo) -> bool {
    info.usage_page == USAGE_PAGE_DIGITIZER
}

fn report_may_contain_pen_data(device: &HidDevice, report_id: u8) -> bool {
    device.pen_reports.contains(&report_id)
}

fn axis_span(info: ValueInfo) -> i64 {
    (info.logical_max as i64 - info.logical_min as i64).max(0)
}

fn set_axis_candidate(slot: &mut Option<(i32, ValueInfo)>, value: i32, info: ValueInfo) {
    let replace = match *slot {
        Some((_, current)) => axis_span(info) > axis_span(current),
        None => true,
    };
    if replace {
        *slot = Some((value, info));
    }
}

fn parse_hid_entries(
    device: &mut HidDevice,
    report_id: u8,
    entries: &[HIDP_DATA],
) -> Option<PenSample> {
    let mut x_value = None;
    let mut y_value = None;
    let mut pressure_value = None;
    let mut tilt_x_value = None;
    let mut tilt_y_value = None;
    let mut tip = false;
    let mut barrel = false;
    let mut second_barrel = false;
    let mut eraser = false;
    let mut in_range = false;

    for entry in entries {
        let key = (report_id, entry.DataIndex);
        if let Some(button) = device.buttons.get(&key).copied() {
            let on = unsafe { entry.Anonymous.On } != 0;
            match (button.usage_page, button.usage) {
                (USAGE_PAGE_DIGITIZER, 0x3c) => eraser |= on,
                (USAGE_PAGE_DIGITIZER, 0x42) => tip |= on,
                (USAGE_PAGE_DIGITIZER, 0x43) => second_barrel |= on,
                (USAGE_PAGE_DIGITIZER, 0x44) => barrel |= on,
                (USAGE_PAGE_DIGITIZER, 0x45) => eraser |= on,
                (USAGE_PAGE_DIGITIZER, 0x50) => in_range |= on,
                (USAGE_PAGE_BUTTON, 0x01) => tip |= on,
                (USAGE_PAGE_BUTTON, 0x02) => barrel |= on,
                (USAGE_PAGE_BUTTON, 0x03) => second_barrel |= on,
                _ => {}
            }
            continue;
        }

        let Some(info) = device.values.get(&key).copied() else {
            continue;
        };
        let value = unsafe { entry.Anonymous.RawValue } as i32;
        match (info.usage_page, info.usage) {
            (USAGE_PAGE_GENERIC_DESKTOP, 0x30) if info.is_absolute => {
                set_axis_candidate(&mut x_value, value, info)
            }
            (USAGE_PAGE_GENERIC_DESKTOP, 0x31) if info.is_absolute => {
                set_axis_candidate(&mut y_value, value, info)
            }
            (USAGE_PAGE_GENERIC_DESKTOP, 0x30 | 0x31) => {}
            (USAGE_PAGE_DIGITIZER, 0x30) => {
                set_axis_candidate(&mut pressure_value, value, info)
            }
            (USAGE_PAGE_DIGITIZER, 0x3d) => set_axis_candidate(&mut tilt_x_value, value, info),
            (USAGE_PAGE_DIGITIZER, 0x3e) => set_axis_candidate(&mut tilt_y_value, value, info),
            (USAGE_PAGE_DIGITIZER, 0x3c) => eraser |= value != 0,
            (USAGE_PAGE_DIGITIZER, 0x42) => tip |= value != 0,
            (USAGE_PAGE_DIGITIZER, 0x43) => second_barrel |= value != 0,
            (USAGE_PAGE_DIGITIZER, 0x44) => barrel |= value != 0,
            (USAGE_PAGE_DIGITIZER, 0x45) => eraser |= value != 0,
            (USAGE_PAGE_DIGITIZER, 0x50) => in_range |= value != 0,
            (USAGE_PAGE_BUTTON, 0x01) => tip |= value != 0,
            (USAGE_PAGE_BUTTON, 0x02) => barrel |= value != 0,
            (USAGE_PAGE_BUTTON, 0x03) => second_barrel |= value != 0,
            _ => {}
        }
    }

    let has_position = x_value.is_some() || y_value.is_some();
    let has_signal = has_position
        || pressure_value.is_some()
        || tilt_x_value.is_some()
        || tilt_y_value.is_some()
        || tip
        || barrel
        || second_barrel
        || eraser
        || in_range
        || device.range_reports.contains(&report_id);
    if !has_signal {
        return None;
    }

    if let Some((value, info)) = x_value {
        device.last_x = normalize_absolute(value, info);
    }
    if let Some((value, info)) = y_value {
        device.last_y = normalize_absolute(value, info);
    }
    if let Some((value, info)) = pressure_value {
        device.last_pressure = normalize_absolute(value, info);
    }
    if let Some((value, info)) = tilt_x_value {
        device.last_tilt_x = normalize_tilt(value, info);
    }
    if let Some((value, info)) = tilt_y_value {
        device.last_tilt_y = normalize_tilt(value, info);
    }

    tip |= device.last_pressure > 0.002;
    let has_range_cap = device.range_reports.contains(&report_id);
    let signal = if has_range_cap {
        in_range
    } else {
        tip
            || device.last_pressure > 0.002
            || has_position
            || barrel
            || second_barrel
            || eraser
    };
    // Same latch as the Wacom path: one report that proves the pen is on the
    // tablet keeps it there until the reports go quiet.
    let in_range = device.range.observe(signal, Instant::now());
    if !in_range {
        device.last_pressure = 0.0;
    }

    Some(PenSample {
        nx: device.last_x,
        ny: device.last_y,
        pressure: device.last_pressure,
        tilt_x: device.last_tilt_x,
        tilt_y: device.last_tilt_y,
        tip: tip && in_range,
        barrel,
        second_barrel,
        eraser,
        in_range,
    })
}

fn parse_hid_pen(
    device: &mut HidDevice,
    report: &[u8],
    entries: &mut [HIDP_DATA],
) -> Option<PenSample> {
    let report_length = device.caps.InputReportByteLength as usize;
    if report_length == 0 || report.is_empty() || device.max_data_len == 0 || entries.is_empty() {
        return None;
    }

    if report.len() == report_length {
        return parse_hid_candidate(device, report, entries);
    }
    if report.len() == report_length + 1 {
        if let Some(sample) = parse_hid_candidate(device, &report[..report_length], entries) {
            return Some(sample);
        }
        return parse_hid_candidate(device, &report[1..], entries);
    }

    for candidate in report_candidates(report, report_length) {
        if candidate.len() != report_length {
            continue;
        }
        if let Some(sample) = parse_hid_candidate(device, &candidate, entries) {
            return Some(sample);
        }
    }
    None
}

fn parse_hid_candidate(
    device: &mut HidDevice,
    report: &[u8],
    entries: &mut [HIDP_DATA],
) -> Option<PenSample> {
    let report_id = report.first().copied()?;
    if !report_id_has_caps(device, report_id) || !report_may_contain_pen_data(device, report_id) {
        return None;
    }

    let mut entry_count = entries.len() as u32;
    let status = unsafe {
        HidP_GetData(
            HidP_Input,
            entries.as_mut_ptr(),
            &mut entry_count,
            device.preparsed.as_mut_ptr() as isize,
            report.as_ptr() as *mut u8,
            report.len() as u32,
        )
    };
    if status != HIDP_STATUS_SUCCESS {
        return None;
    }
    let count = (entry_count as usize).min(entries.len());
    parse_hid_entries(device, report_id, &entries[..count])
}

fn report_candidates(report: &[u8], expected_length: usize) -> Vec<Vec<u8>> {
    fn push_unique(candidates: &mut Vec<Vec<u8>>, candidate: Vec<u8>) {
        if !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    }

    let mut candidates = Vec::with_capacity(4);
    if expected_length == 0 || report.is_empty() {
        return candidates;
    }
    if report.len() >= expected_length {
        push_unique(&mut candidates, report[..expected_length].to_vec());
        if report.len() > expected_length {
            push_unique(&mut candidates, report[1..expected_length + 1].to_vec());
        }
    } else {
        let mut leading_padded = vec![0u8; expected_length];
        leading_padded[expected_length - report.len()..].copy_from_slice(report);
        push_unique(&mut candidates, leading_padded);

        let mut trailing_padded = report.to_vec();
        trailing_padded.resize(expected_length, 0);
        push_unique(&mut candidates, trailing_padded);
    }

    if report.len() + 1 == expected_length {
        let mut with_id = vec![0u8; expected_length];
        with_id[1..].copy_from_slice(report);
        push_unique(&mut candidates, with_id);
    }
    candidates
}

fn normalize_absolute(value: i32, info: ValueInfo) -> f32 {
    let span = info.logical_max.saturating_sub(info.logical_min);
    if span <= 0 {
        return 0.0;
    }
    ((value - info.logical_min) as f32 / span as f32).clamp(0.0, 1.0)
}

fn normalize_tilt(value: i32, info: ValueInfo) -> f32 {
    let span = info.logical_max.saturating_sub(info.logical_min);
    if span <= 0 {
        return 0.0;
    }
    if info.logical_min < 0 {
        let extent = info.logical_max.abs().max(info.logical_min.abs()).max(1);
        (value as f32 / extent as f32).clamp(-1.0, 1.0)
    } else {
        let center = info.logical_min as f32 + span as f32 * 0.5;
        ((value as f32 - center) / (span as f32 * 0.5).max(1.0)).clamp(-1.0, 1.0)
    }
}

fn pen_controls_changed(previous: PenSample, next: PenSample) -> bool {
    // Position and pressure can be coalesced; button/range edges must never
    // be dropped or the model can stay stuck with a held tip.
    previous.tip != next.tip
        || previous.barrel != next.barrel
        || previous.second_barrel != next.second_barrel
        || previous.eraser != next.eraser
        || previous.in_range != next.in_range
}

fn pen_moved(previous: PenSample, next: PenSample) -> bool {
    // A nib that rests on the tablet still reports tiny jitter. Only a real
    // displacement or a pressure change is worth forwarding to the webview.
    (previous.nx - next.nx).abs() > PEN_MOVE_EPSILON
        || (previous.ny - next.ny).abs() > PEN_MOVE_EPSILON
        || (previous.pressure - next.pressure).abs() > 0.02
}

fn flush_pen(device: &mut HidDevice, app: &AppHandle) {
    let Some(sample) = device.pending_sample else {
        return;
    };
    let controls_changed = device
        .last_sample
        .map_or(true, |previous| pen_controls_changed(previous, sample));
    let moved = device
        .last_sample
        .map_or(true, |previous| pen_moved(previous, sample));
    let unchanged = !moved && !controls_changed;
    let heartbeat_due =
        unchanged && sample.in_range && device.last_emit.elapsed() >= PEN_HEARTBEAT_INTERVAL;
    if unchanged && !heartbeat_due {
        device.pending_sample = None;
        return;
    }

    if !sample.in_range && !controls_changed {
        device.pending_sample = None;
        return;
    }
    if !controls_changed && device.last_emit.elapsed() < PEN_EMIT_INTERVAL {
        return;
    }

    device.pending_sample = None;
    device.last_emit = Instant::now();
    device.last_sample = Some(sample);
    device.pen_tip_down = sample.tip;
    let _ = app.emit(
        "kuro-input",
        InputEvent::TabletPen {
            nx: sample.nx,
            ny: sample.ny,
            pressure: sample.pressure,
            tilt_x: sample.tilt_x,
            tilt_y: sample.tilt_y,
            tip: sample.tip,
            barrel: sample.barrel,
            second_barrel: sample.second_barrel,
            eraser: sample.eraser,
            in_range: sample.in_range,
        },
    );
}

fn flush_pending_pens(context: &mut TabletContext) {
    for device in context.devices.values_mut() {
        flush_pen(device, &context.app);
    }
    let tip_down = context.devices.values().any(|device| device.pen_tip_down);
    update_pen_activity(context, tip_down);
}

/// Keeps the rest of the system in sync with what the nib is doing.
///
/// Windows mirrors the pen into the OS mouse pointer. While the nib is down
/// those synthetic moves only duplicate the pen stream, so they are dropped
/// inside the mouse hook. The global hooks themselves are paused for the
/// same time so that Photoshop / CSP get the untouched input path.
fn update_pen_activity(context: &mut TabletContext, tip_down: bool) {
    if tip_down {
        crate::input_hook::suppress_mouse_moves_for(PEN_MOUSE_SUPPRESS_WINDOW);
    }

    let should_pause = tip_down && pause_hooks_while_drawing(&context.app);
    if should_pause {
        // The pause runs on a deadline that every fresh pen report extends.
        crate::input_hook::refresh_drawing_pause(PEN_DRAWING_PAUSE_WINDOW);
    } else if context.drawing_pause_active {
        crate::input_hook::set_drawing_pause(false);
    }
    context.drawing_pause_active = should_pause;
}

/// Reads the tray setting that decides whether the global hooks are paused
/// while the nib is down.
fn pause_hooks_while_drawing(app: &AppHandle) -> bool {
    app.try_state::<crate::AppState>()
        .and_then(|state| {
            state
                .settings
                .lock()
                .ok()
                .map(|settings| settings.pause_hooks_while_drawing)
        })
        .unwrap_or(false)
}

fn pending_pen_timeout(context: &TabletContext) -> Option<Duration> {
    context
        .devices
        .values()
        .filter(|device| device.pending_sample.is_some())
        .map(|device| PEN_EMIT_INTERVAL.saturating_sub(device.last_emit.elapsed()))
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_device() -> HidDevice {
        HidDevice {
            meta: DeviceMeta {
                path: String::new(),
                name: String::new(),
                vendor_id: WACOM_VENDOR_ID,
                usage_page: USAGE_PAGE_WACOM_TABLET,
                usage: 0x0a,
            },
            preparsed: Vec::new(),
            caps: unsafe { zeroed() },
            values: HashMap::new(),
            buttons: HashMap::new(),
            last_x: 0.5,
            last_y: 0.5,
            last_raw_x: 0,
            last_raw_y: 0,
            last_tilt_x: 0.0,
            last_tilt_y: 0.0,
            last_pressure: 0.0,
            range: PenRange::default(),
            last_sample: None,
            pending_sample: None,
            pen_tip_down: false,
            last_emit: Instant::now(),
            max_data_len: 0,
            entries: Vec::new(),
            known_reports: HashSet::new(),
            pen_reports: HashSet::new(),
            range_reports: HashSet::new(),
            aux_buttons: 0,
            wacom_max_x: WACOM_CTL_6100_MAX_X,
            wacom_max_y: WACOM_CTL_6100_MAX_Y,
            wacom_max_pressure: WACOM_CTL_6100_MAX_PRESSURE,
        }
    }

    #[test]
    fn parses_wacom_v3_pen_report_with_leading_byte() {
        let mut report = vec![0u8; 193];
        report[0] = 0x02;
        report[1] = WACOM_PEN_REPORT_ID;
        report[2] = 0x20;
        report[3] = 0x30;
        report[4] = 0x2a;
        report[5] = 0x00;
        report[6] = 0x5e;
        report[7] = 0x1a;
        report[8] = 0x00;
        report[9] = 0x00;
        report[10] = 0x08;

        let mut device = fake_device();
        let sample = parse_wacom_pen(&mut device, &report, 1).expect("valid pen report");
        assert!(sample.in_range);
        assert!(sample.tip);
        assert!((sample.nx - 0.5).abs() < 0.001);
        assert!((sample.ny - 0.5).abs() < 0.001);
        assert!((sample.pressure - 0.5).abs() < 0.01);
    }

    #[test]
    fn parses_wacom_v3_pen_report_without_leading_byte() {
        let mut report = vec![0u8; 192];
        report[0] = WACOM_PEN_REPORT_ID;
        report[1] = 0x20;
        report[2] = 0x20;
        report[3] = 0x00;
        report[4] = 0x00;
        report[5] = 0x10;
        report[6] = 0x00;
        report[7] = 0x00;
        report[8] = 0xff;
        report[9] = 0x0f;

        let mut device = fake_device();
        let sample = parse_wacom_pen(&mut device, &report, 0).expect("valid pen report");
        assert!(sample.in_range);
        assert!((sample.nx - 32.0 / WACOM_CTL_6100_MAX_X).abs() < 0.001);
        assert!((sample.ny - 16.0 / WACOM_CTL_6100_MAX_Y).abs() < 0.001);
        assert!(sample.pressure > 0.99);
    }

    #[test]
    fn ignores_report_id_bytes_inside_pen_coordinates() {
        let mut report = vec![0u8; 192];
        report[0] = WACOM_PEN_REPORT_ID;
        report[1] = 0x20;
        report[2] = 0x10;
        report[3] = 0x11;
        report[4] = 0x00;

        assert_eq!(find_report_id(&report, WACOM_PEN_REPORT_ID), Some(0));
        assert_eq!(find_report_id(&report, WACOM_AUX_REPORT_ID), None);
    }

    #[test]
    fn report_candidates_handles_driver_prefix_byte() {
        let report = [0x02, 0x10, 0x20, 0x30, 0x40];
        let candidates = report_candidates(&report, 4);

        assert_eq!(candidates[0], [0x02, 0x10, 0x20, 0x30]);
        assert!(candidates
            .iter()
            .any(|candidate| candidate == &[0x10, 0x20, 0x30, 0x40]));
    }

    #[test]
    fn report_candidates_recovers_missing_report_id() {
        let candidates = report_candidates(&[0xab, 0xcd], 3);
        assert!(candidates
            .iter()
            .any(|candidate| candidate == &[0x00, 0xab, 0xcd]));
    }

    #[test]
    fn normalizes_absolute_values_with_clamping() {
        let info = ValueInfo {
            report_id: 0x01,
            usage_page: USAGE_PAGE_GENERIC_DESKTOP,
            usage: 0x30,
            logical_min: 100,
            logical_max: 1100,
            is_absolute: true,
        };
        assert!((normalize_absolute(600, info) - 0.5).abs() < 0.001);
        assert_eq!(normalize_absolute(-100, info), 0.0);
        assert_eq!(normalize_absolute(5000, info), 1.0);
    }

    #[test]
    fn rejects_relative_axes_and_mouse_only_buttons() {
        let relative_axis = ValueInfo {
            report_id: 0x02,
            usage_page: USAGE_PAGE_GENERIC_DESKTOP,
            usage: 0x30,
            logical_min: -127,
            logical_max: 127,
            is_absolute: false,
        };
        let mouse_button = ButtonInfo {
            report_id: 0x02,
            usage_page: USAGE_PAGE_BUTTON,
            usage: 0x01,
        };

        assert!(!is_pen_value_usage(relative_axis));
        assert!(!is_pen_button_usage(mouse_button));
    }

    #[test]
    fn derives_wacom_limits_from_hid_caps() {
        let mut values = HashMap::new();
        values.insert(
            (0x10, 1),
            ValueInfo {
                report_id: 0x10,
                usage_page: USAGE_PAGE_GENERIC_DESKTOP,
                usage: 0x30,
                logical_min: 0,
                logical_max: 32000,
                is_absolute: true,
            },
        );
        values.insert(
            (0x10, 2),
            ValueInfo {
                report_id: 0x10,
                usage_page: USAGE_PAGE_GENERIC_DESKTOP,
                usage: 0x31,
                logical_min: 0,
                logical_max: 20000,
                is_absolute: true,
            },
        );
        values.insert(
            (0x10, 3),
            ValueInfo {
                report_id: 0x10,
                usage_page: USAGE_PAGE_DIGITIZER,
                usage: 0x30,
                logical_min: 0,
                logical_max: 8191,
                is_absolute: true,
            },
        );

        assert_eq!(
            infer_wacom_pen_limits(&values),
            (32000.0, 20000.0, 8191.0)
        );
    }

    #[test]
    fn derives_proximity_from_movement_when_the_status_bit_is_clear() {
        // Firmware generations disagree about which bit carries "in
        // proximity". A nib that moved is on the tablet no matter what the
        // status byte says.
        let mut report = vec![0u8; 192];
        report[0] = WACOM_PEN_REPORT_ID;
        report[1] = 0x00;
        report[2] = 0x40;
        report[3] = 0x00;
        report[4] = 0x00;
        report[5] = 0x40;
        report[6] = 0x00;
        report[7] = 0x00;
        report[8] = 0x00;
        report[9] = 0x00;

        let mut device = fake_device();
        let sample = parse_wacom_pen(&mut device, &report, 0).expect("valid pen report");
        assert!(sample.in_range, "a moved nib has to stay in range");

        // The very same report without movement and without a proximity bit
        // is a dropped status byte, not a pen that left the tablet. The
        // latched range keeps the nib where it was.
        let parked = report.clone();
        let sample = parse_wacom_pen(&mut device, &parked, 0).expect("valid pen report");
        assert!(sample.in_range, "a parked nib has to stay in range");
    }

    #[test]
    fn latches_the_pen_range_until_the_reports_go_quiet() {
        let base = Instant::now();
        let mut range = PenRange::default();

        assert!(!range.observe(false, base), "an untouched pen is out of range");
        assert!(range.observe(true, base), "one signal latches the nib");
        assert!(
            range.observe(false, base + Duration::from_millis(100)),
            "a dropped status byte must not release the nib"
        );
        assert!(
            range.observe(false, base + Duration::from_millis(1_400)),
            "the nib survives a short glitch"
        );
        assert!(
            !range.observe(false, base + Duration::from_millis(1_600)),
            "the nib is released once the reports go quiet"
        );
        assert!(
            range.observe(true, base + Duration::from_millis(1_700)),
            "a new signal latches the nib again"
        );
    }

    #[test]
    fn keeps_updating_the_position_while_the_range_is_latched() {
        let mut report = vec![0u8; 192];
        report[0] = WACOM_PEN_REPORT_ID;
        report[1] = 0x20;
        report[2] = 0x40;
        report[3] = 0x00;
        report[4] = 0x00;
        report[5] = 0x40;
        report[6] = 0x00;
        report[7] = 0x00;
        report[8] = 0x00;
        report[9] = 0x00;

        let mut device = fake_device();
        let first = parse_wacom_pen(&mut device, &report, 0).expect("valid pen report");
        assert!(first.in_range);

        // The status byte drops but the nib moved: the latched range keeps the
        // pen on the tablet and the position has to follow.
        let mut moved = report.clone();
        moved[1] = 0x00;
        moved[2] = 0x80;
        let second = parse_wacom_pen(&mut device, &moved, 0).expect("valid pen report");
        assert!(second.in_range);
        assert!(
            second.nx > first.nx,
            "the nib has to follow the report while the range is latched"
        );
    }

    #[test]
    fn treats_the_origin_without_pressure_as_out_of_range() {
        // Drivers that report the origin once the pen leaves the tablet must
        // not drag the nib into the corner.
        let mut report = vec![0u8; 192];
        report[0] = WACOM_PEN_REPORT_ID;
        report[1] = 0x20;
        report[2] = 0x40;
        report[3] = 0x00;
        report[4] = 0x00;
        report[5] = 0x40;
        report[6] = 0x00;
        report[7] = 0x00;
        report[8] = 0x00;
        report[9] = 0x00;

        let mut device = fake_device();
        let sample = parse_wacom_pen(&mut device, &report, 0).expect("valid pen report");
        assert!(sample.in_range);
        assert!(sample.nx > 0.001, "the nib starts on the reported spot");

        let mut origin = report.clone();
        origin[2] = 0x00;
        origin[3] = 0x00;
        origin[4] = 0x00;
        origin[5] = 0x00;
        origin[6] = 0x00;
        origin[7] = 0x00;
        let sample = parse_wacom_pen(&mut device, &origin, 0).expect("valid pen report");
        assert!(sample.in_range, "the latch keeps the nib alive");
        assert!(
            sample.nx > 0.001,
            "the origin without pressure must not drag the nib into the corner"
        );
    }

    #[test]
    fn ignores_sub_pixel_jitter_but_reports_real_movement() {
        let base = PenSample {
            nx: 0.4,
            ny: 0.4,
            pressure: 0.2,
            in_range: true,
            ..PenSample::default()
        };
        let jitter = PenSample {
            nx: 0.4 + PEN_MOVE_EPSILON * 0.5,
            ..base
        };
        let moved = PenSample { nx: 0.5, ..base };

        assert!(!pen_moved(base, jitter));
        assert!(pen_moved(base, moved));
    }

    #[test]
    fn control_edges_bypass_pen_rate_limit() {
        let base = PenSample {
            nx: 0.4,
            ny: 0.4,
            pressure: 0.2,
            in_range: true,
            ..PenSample::default()
        };
        let moved = PenSample { nx: 0.5, ..base };
        let tipped = PenSample { tip: true, ..base };

        assert!(!pen_controls_changed(base, moved));
        assert!(pen_controls_changed(base, tipped));
    }

    fn raw_hid_buffer(report_size: usize, report_count: usize) -> (Vec<usize>, usize) {
        let header_size = size_of::<RAWINPUTHEADER>();
        let fixed_size = header_size + size_of::<u32>() * 2;
        let total = fixed_size + report_size * report_count;
        let words = (total + size_of::<usize>() - 1) / size_of::<usize>();
        let mut buffer = vec![0usize; words];
        let ptr = buffer.as_mut_ptr() as *mut u8;

        unsafe {
            let raw = &mut *(ptr as *mut RAWINPUT);
            raw.header.dwType = RIM_TYPEHID;
            raw.header.hDevice = 0x1234usize as HANDLE;
            raw.data.hid = windows_sys::Win32::UI::Input::RAWHID {
                dwSizeHid: report_size as u32,
                dwCount: report_count as u32,
                bRawData: [0],
            };
            let payload = slice::from_raw_parts_mut(ptr.add(fixed_size), report_size * report_count);
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte = (index % 251) as u8 + 1;
            }
        }

        (buffer, total)
    }

    #[test]
    fn raw_hid_packet_reads_from_the_original_buffer() {
        let report_size = 193;
        let report_count = 2;
        let (buffer, total) = raw_hid_buffer(report_size, report_count);

        let packet = raw_hid_packet(&buffer, total).expect("valid raw HID packet");
        assert_eq!(packet.device, 0x1234usize as HANDLE);
        assert_eq!(packet.report_size, report_size);
        assert_eq!(packet.report_count, report_count);
        assert_eq!(packet.reports.len(), report_size * report_count);
        assert_eq!(packet.reports[0], 1);
        assert_eq!(packet.reports[report_size - 1], report_size as u8);
        assert_eq!(packet.reports[report_size], (report_size % 251) as u8 + 1);
    }

    #[test]
    fn raw_hid_packet_rejects_truncated_payload() {
        let (buffer, total) = raw_hid_buffer(16, 1);
        assert!(raw_hid_packet(&buffer, total - 1).is_none());
    }
}
