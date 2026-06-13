import uiautomator2 as u2
import time
from datetime import datetime
import threading
from queue import Queue, Empty
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
import re
import argparse
import subprocess

INPUT_FILE = "gsuite.txt"
RESULT_FILE = "Hasil-Gdoku.txt"

def env_float(name, default):
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return float(default)

U2_WAIT_TIMEOUT = env_float("U2_WAIT_TIMEOUT", 10)
ACTION_TIMEOUT_MULTIPLIER = env_float("U2_ACTION_TIMEOUT_MULTIPLIER", 1)
SLEEP_MULTIPLIER = env_float("U2_SLEEP_MULTIPLIER", 1)

def action_timeout(seconds):
    return max(1, int(round(float(seconds) * ACTION_TIMEOUT_MULTIPLIER)))

def pause(seconds):
    time.sleep(float(seconds) * SLEEP_MULTIPLIER)

# ====== Auto-switch VPN ExpressVPN (dipakai saat Play Store gagal terus) ======
VPN_UK_LOCATIONS = [
    loc.strip()
    for loc in os.getenv(
        "VPN_UK_LOCATIONS",
        "UK - London,UK - East London,UK - Wembley,UK - Docklands,UK - Midlands",
    ).split(",")
    if loc.strip()
]
# Perintah switch VPN; {location} diganti nama lokasi. Default pakai CLI ExpressVPN.
# Bisa di-override di .env (mis. pakai script/PowerShell sendiri).
VPN_SWITCH_CMD = os.getenv("VPN_SWITCH_CMD", 'expressvpn connect "{location}"')
VPN_DISCONNECT_CMD = os.getenv("VPN_DISCONNECT_CMD", "expressvpn disconnect")
VPN_SWITCH_WAIT = int(os.getenv("VPN_SWITCH_WAIT", "10"))

_vpn_lock = threading.Lock()
_vpn_index = 0


def switch_vpn_uk(logger=print):
    """Ganti ExpressVPN ke lokasi UK berikutnya (rotasi). Return True kalau sukses."""
    global _vpn_index
    if not VPN_UK_LOCATIONS:
        logger("VPN_UK_LOCATIONS kosong, lewati switch VPN")
        return False
    with _vpn_lock:
        location = VPN_UK_LOCATIONS[_vpn_index % len(VPN_UK_LOCATIONS)]
        _vpn_index += 1
    try:
        logger(f"Ganti VPN ExpressVPN -> {location}")
        if VPN_DISCONNECT_CMD:
            try:
                subprocess.run(VPN_DISCONNECT_CMD, shell=True, timeout=60, capture_output=True, text=True)
            except Exception as e:
                logger(f"VPN disconnect gagal (lanjut): {e}")
            time.sleep(2)
        cmd = VPN_SWITCH_CMD.replace("{location}", location)
        result = subprocess.run(cmd, shell=True, timeout=120, capture_output=True, text=True)
        out = (result.stdout or result.stderr or "").strip()[:200]
        logger(f"VPN connect rc={result.returncode} {out}")
        time.sleep(VPN_SWITCH_WAIT)
        return result.returncode == 0
    except Exception as e:
        logger(f"Gagal switch VPN: {e}")
        return False

class EmulatorAutomator:
    def __init__(self, port, name):
        self.port = port
        self.name = name
        self.device = None
        self.email_queue = Queue()
        self.doku_queue = Queue()
        self.used_doku_lock = threading.Lock()
        self.result_file_lock = threading.Lock()  # Lock untuk file hasil
        
    def log_info(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] INFO: {safe_message}", flush=True)

    def log_warn(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] WARNING: {safe_message}", flush=True)

    def log_error(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] ERROR: {safe_message}", flush=True)

    def emit_progress(self, email, percent, label):
        safe_email = str(email).replace("|", " ").strip()
        safe_label = str(label).replace("|", " ").strip()
        safe_label = safe_label.encode("ascii", "replace").decode("ascii")
        print(f"PSC_PROGRESS|{safe_email}|{int(percent)}|{safe_label}", flush=True)

    def connect(self):
        try:
            self.log_info(f"Connecting to emulator at 127.0.0.1:{self.port}...")
            self.device = u2.connect(f"127.0.0.1:{self.port}")
            self.device.settings['wait_timeout'] = U2_WAIT_TIMEOUT
            self.device.settings['operation_delay'] = (0.2, 0.8)
            self.log_info("Successfully connected to emulator.")
            return True
        except Exception as e:
            self.log_error(f"Failed to connect to emulator: {e}")
            return False

    def ensure_connected(self):
        """Cek koneksi emulator; reconnect kalau terputus (emulator stuck/restart di tengah jalan)."""
        try:
            _ = self.device.info  # akan error kalau device terputus
            return True
        except Exception as e:
            self.log_warn(f"Emulator {self.port} terputus ({e}), mencoba reconnect...")
            for attempt in range(1, int(os.getenv("EMU_RECONNECT_TRIES", "3")) + 1):
                try:
                    if self.connect():
                        self.log_info(f"Reconnect emulator {self.port} berhasil (attempt {attempt})")
                        return True
                except Exception:
                    pass
                pause(3)
            self.log_error(f"Reconnect emulator {self.port} gagal setelah beberapa percobaan")
            return False

    def close_notification_shade(self):
        """Tutup panel notifikasi/quick settings kalau kebuka (mis. notif VPN ExpressVPN).
        Pakai 'statusbar collapse' SAJA — TIDAK press back, biar tidak salah keluar dari layar aktif."""
        try:
            self.device.shell("cmd statusbar collapse")
        except Exception:
            pass

    def fast_click_text(self, text_list, timeout=3):
        """Text clicking with configurable timeout for slower RDP/emulator sessions"""
        for text in text_list:
            selector = self.device(textMatches="(?i)" + text)
            try:
                if selector.exists(timeout=0):
                    selector.click()
                    self.log_info(f"Clicked immediately by text: {text}")
                    return True
            except Exception:
                pass
        for text in text_list:
            self.log_info(f"Waiting/clicking text: {text}, timeout={action_timeout(timeout)}s")
            if self.device(textMatches="(?i)" + text).click_exists(timeout=action_timeout(timeout)):
                self.log_info(f"Clicked by text after wait: {text}")
                return True
        return False

    def set_text_fast(self, value, timeout=5, **selector_kwargs):
        selector = self.device(**selector_kwargs)
        self.log_info(f"Trying set_text immediate: {selector_kwargs}")
        try:
            if selector.exists(timeout=0):
                selector.set_text(value)
                self.log_info(f"set_text immediate success: {selector_kwargs}")
                return True
        except Exception:
            pass

        self.log_info(f"Waiting input for set_text: {selector_kwargs}, timeout={action_timeout(timeout)}s")
        if selector.exists(timeout=action_timeout(timeout)):
            selector.set_text(value)
            self.log_info(f"set_text success after wait: {selector_kwargs}")
            return True
        self.log_warn(f"set_text target not found: {selector_kwargs}")
        return False

    def exists_fast(self, timeout=3, **selector_kwargs):
        selector = self.device(**selector_kwargs)
        try:
            if selector.exists(timeout=0):
                self.log_info(f"exists immediate true: {selector_kwargs}")
                return True
        except Exception:
            pass
        self.log_info(f"Waiting exists: {selector_kwargs}, timeout={action_timeout(timeout)}s")
        exists = selector.exists(timeout=action_timeout(timeout))
        self.log_info(f"exists result {exists}: {selector_kwargs}")
        return exists

    def dismiss_crash_dialogs(self):
        """Close common Android/Google crash dialogs without changing the main flow."""
        dialog_buttons = [
            "Close app",
            "App info",
            "OK",
            "Got it",
            "No thanks",
            "Not now",
            "Skip",
            "Tutup aplikasi",
            "Oke",
            "Nanti saja",
        ]
        # Cek INSTAN (timeout=0): dialog crash kalau ada pasti sudah tampil, jadi tidak
        # perlu nunggu per-tombol (dulu 10 tombol x 1 detik = ~10 detik terbuang tiap panggil).
        for text in dialog_buttons:
            try:
                sel = self.device(textMatches="(?i)" + text)
                if sel.exists(timeout=0):
                    sel.click()
                    self.log_warn(f"Dismissed dialog/button: {text}")
                    pause(0.3)
                    return True
            except Exception:
                continue
        return False

    def _shell_output(self, command):
        result = self.device.shell(command)
        if isinstance(result, str):
            return result
        if hasattr(result, "output"):
            return result.output or ""
        if isinstance(result, (list, tuple)) and result:
            return str(result[0] or "")
        return str(result or "")

    def _dumpsys_account_output(self):
        try:
            return self._shell_output("dumpsys account")
        except Exception as e:
            self.log_error(f"Failed reading dumpsys account: {e}")
            return ""

    def _google_account_emails_dumpsys(self):
        out = self._dumpsys_account_output()
        emails = []
        patterns = [
            r"Account\s*\{\s*name=([^,\}]+),\s*type=com\.google\s*\}",
            r"name=([^,\}\s]+),\s*type=com\.google",
        ]
        for pattern in patterns:
            for match in re.findall(pattern, out, flags=re.IGNORECASE):
                email = match.strip().lower()
                if "@" in email and email not in emails:
                    emails.append(email)
        return emails

    def _has_google_account_dumpsys(self):
        return len(self._google_account_emails_dumpsys()) > 0

    def _verify_google_account_dumpsys(self, email):
        expected = email.strip().lower()
        detected = expected in self._google_account_emails_dumpsys()
        if detected:
            self.log_info(f"Account terdeteksi di dumpsys: {email}")
        return detected

    def click_candidates(self, resource_ids=None, texts=None, timeout=3):
        resource_ids = resource_ids or []
        texts = texts or []
        self.log_info(f"click_candidates start resource_ids={resource_ids} texts={texts} timeout={action_timeout(timeout)}s")

        if texts:
            for resource_id in resource_ids:
                for text in texts:
                    try:
                        selector = self.device(resourceId=resource_id, textMatches="(?i)" + text)
                        if selector.exists(timeout=0):
                            selector.click()
                            self.log_info(f"Clicked immediately by resource-id/text: {resource_id} / {text}")
                            return True
                    except Exception:
                        continue
            for resource_id in resource_ids:
                for text in texts:
                    try:
                        if self.device(resourceId=resource_id, textMatches="(?i)" + text).click_exists(timeout=action_timeout(timeout)):
                            self.log_info(f"Clicked by resource-id/text: {resource_id} / {text}")
                            return True
                    except Exception:
                        continue
        else:
            for resource_id in resource_ids:
                try:
                    selector = self.device(resourceId=resource_id)
                    if selector.exists(timeout=0):
                        selector.click()
                        self.log_info(f"Clicked immediately by resource-id: {resource_id}")
                        return True
                except Exception:
                    continue
            for resource_id in resource_ids:
                try:
                    if self.device(resourceId=resource_id).click_exists(timeout=action_timeout(timeout)):
                        self.log_info(f"Clicked by resource-id: {resource_id}")
                        return True
                except Exception:
                    continue

        for text in texts:
            try:
                selector = self.device(textMatches="(?i)" + text)
                if selector.exists(timeout=0):
                    selector.click()
                    self.log_info(f"Clicked immediately by text: {text}")
                    return True
            except Exception:
                continue
        for text in texts:
            try:
                if self.device(textMatches="(?i)" + text).click_exists(timeout=action_timeout(timeout)):
                    self.log_info(f"Clicked by text: {text}")
                    return True
            except Exception:
                continue

        return False

    def click_google_next(self, step_name="Next"):
        # ENTER dulu: paling cepat dan sering langsung memajukan layar.
        try:
            self.device.press("enter")
            pause(0.3)
            self.log_info(f"{step_name}: pressed ENTER as first quick action")
        except Exception as e:
            self.log_warn(f"{step_name}: ENTER press failed: {e}")

        next_ids = [
            "identifierNext",
            "passwordNext",
            "com.google.android.gms:id/identifierNext",
            "com.google.android.gms:id/passwordNext",
            "com.google.android.gms:id/next_button",
            "com.google.android.gms:id/suw_navbar_next",
        ]
        next_texts = ["NEXT", "Next", "Berikutnya", "BERIKUTNYA"]

        # Cek INSTAN (timeout=0): klik tombol Next kalau sudah kelihatan. Tanpa nunggu.
        for rid in next_ids:
            try:
                sel = self.device(resourceId=rid)
                if sel.exists(timeout=0):
                    sel.click()
                    self.log_info(f"{step_name}: NEXT clicked by id {rid}")
                    return True
            except Exception:
                continue
        for t in next_texts:
            try:
                sel = self.device(textMatches="(?i)" + t)
                if sel.exists(timeout=0):
                    sel.click()
                    self.log_info(f"{step_name}: NEXT clicked by text {t}")
                    return True
            except Exception:
                continue

        # Belum kelihatan: tunggu SINGKAT tombol utama (maks ~action_timeout(2)).
        for rid in ["identifierNext", "passwordNext"]:
            try:
                if self.device(resourceId=rid).click_exists(timeout=action_timeout(2)):
                    self.log_info(f"{step_name}: NEXT clicked after short wait by id {rid}")
                    return True
            except Exception:
                continue

        # Tidak ada tombol Next sama sekali -> ENTER kemungkinan sudah memajukan layar.
        self.log_info(f"{step_name}: tombol Next tidak ada, anggap ENTER sudah lanjut")
        return True

    def login_google(self, email, password):
        try:
            self.log_info("Opening Accounts page via SYNC_SETTINGS shortcut intent")
            self.device.shell("am start -a android.settings.SYNC_SETTINGS")
            pause(2)
            self.dismiss_crash_dialogs()

            existing_google_accounts = self._google_account_emails_dumpsys()
            if existing_google_accounts:
                self.log_warn(
                    "Akun Google sisa terdeteksi: "
                    + ", ".join(existing_google_accounts)
                    + ". Hapus dulu biar tidak numpuk/duplikat sebelum login akun baru."
                )
                for leftover in existing_google_accounts:
                    self.fast_remove_google_account(leftover)
                # Buka lagi halaman Accounts untuk lanjut Add account.
                self.device.shell("am start -a android.settings.SYNC_SETTINGS")
                pause(1.5)
                self.dismiss_crash_dialogs()
                if self._google_account_emails_dumpsys():
                    self.log_error("Masih ada akun sisa setelah dihapus, lewati akun ini.")
                    return False
                self.log_info("Akun sisa berhasil dibersihkan, lanjut Add account.")
            else:
                self.log_info("No existing Google account detected, continuing Add account flow")
            if not self.click_candidates(
                resource_ids=["android:id/title"],
                texts=["Add account", "Tambah akun", "Add an account"],
                timeout=4,
            ):
                self.log_error("Cannot find Add account button")
                return False

            pause(1)
            self.dismiss_crash_dialogs()

            if not self.click_candidates(
                resource_ids=["android:id/title"],
                texts=["Google"],
                timeout=5,
            ):
                self.log_error("Cannot find Google account provider")
                return False

            pause(1.5)
            self.dismiss_crash_dialogs()

            # Isi EMAIL dengan FOKUS + VERIFIKASI + RETRY (sama seperti password).
            # Termasuk retry kalau muncul error "Enter an email or phone number" (field kosong).
            self.log_info(f"Input Google email: {email}")
            email_ok = False
            for email_try in range(1, 4):
                self.close_notification_shade()
                email_field = self.device(className="android.widget.EditText")
                if not email_field.exists(timeout=action_timeout(6)):
                    self.log_error("Cannot find Google email input")
                    return False
                try:
                    email_field.click()
                    pause(0.2)
                    email_field.set_text(email)
                except Exception as e:
                    self.log_warn(f"Isi email gagal (try {email_try}): {e}")
                pause(0.4)
                try:
                    current = (self.device(className="android.widget.EditText").info or {}).get("text", "") or ""
                except Exception:
                    current = ""
                if "@" not in current:
                    self.log_warn(f"Email field belum benar ('{current}'), ulangi (try {email_try})")
                    continue
                if not self.click_google_next("Email step"):
                    self.log_error("Cannot click NEXT after email input")
                    return False
                self.dismiss_crash_dialogs()
                pause(1)
                # Cek error email KOSONG -> isi ulang (bukan skip).
                empty_err = False
                for em in ["Enter an email or phone", "Masukkan email atau nomor"]:
                    try:
                        if self.device(textContains=em).exists(timeout=0):
                            empty_err = True
                            break
                    except Exception:
                        continue
                if empty_err:
                    self.log_warn(f"Email kosong terdeteksi (try {email_try}), isi ulang")
                    continue
                email_ok = True
                break
            if not email_ok:
                self.log_error(f"Email gagal diisi dengan benar setelah beberapa percobaan: {email}")
                return False

            # Tunggu salah satu: layar password muncul ATAU error "email tidak terdaftar".
            # Kalau tidak terdaftar -> skip cepat (tidak buang waktu proses penuh).
            self.log_info("Menunggu layar password / cek email terdaftar...")
            not_found_markers = [
                "Couldn't find your Google Account",
                "find your Google Account",
                "Tidak dapat menemukan Akun Google",
                "menemukan Akun Google",
                "Enter a valid email",
                "Masukkan email yang valid",
            ]
            pwd_markers = "(?i)Enter your password|Show password|Masukkan sandi|Lihat sandi"
            deadline = time.time() + action_timeout(8)
            while time.time() < deadline:
                hit = None
                for marker in not_found_markers:
                    try:
                        if self.device(textContains=marker).exists(timeout=0):
                            hit = marker
                            break
                    except Exception:
                        continue
                if hit:
                    self.log_warn(f"Email tidak terdaftar ({hit}): {email}")
                    return "NOT_REGISTERED"
                if self.device(textMatches=pwd_markers).exists(timeout=0):
                    break
                pause(0.4)

            self.log_info("Input Google password")
            pwd_field = self.device(className="android.widget.EditText")
            if not pwd_field.exists(timeout=action_timeout(6)):
                self.log_error("Cannot find Google password input")
                return False

            # Isi password dengan FOKUS + VERIFIKASI + RETRY biar tidak kosong saat klik NEXT.
            filled = False
            for attempt in range(1, 4):
                try:
                    pwd_field.click()          # fokuskan field dulu
                    pause(0.2)
                    pwd_field.set_text(password)
                except Exception as e:
                    self.log_warn(f"Isi password gagal (attempt {attempt}): {e}")
                pause(0.4)
                # Cek field benar-benar terisi sebelum lanjut.
                try:
                    current = (self.device(className="android.widget.EditText").info or {}).get("text", "") or ""
                except Exception:
                    current = ""
                if current.strip():
                    filled = True
                    self.log_info(f"Password terisi (attempt {attempt})")
                    break
                self.log_warn(f"Password terbaca kosong, ulangi isi (attempt {attempt})")

            if not filled:
                self.log_warn("Password verif kosong (mungkin ter-mask), tetap lanjut klik NEXT")
            pause(0.3)
            if not self.click_google_next("Password step"):
                self.log_error("Cannot click NEXT after password input")
                return False
            self.dismiss_crash_dialogs()

            confirmation_buttons = [
                "I UNDERSTAND",
                "I agree",
                "MORE",
                "ACCEPT",
                "Saya setuju",
                "Lainnya",
                "Terima",
            ]

            # Layar konfirmasi (Terms of Service / Welcome to your new account).
            # Pola satset: klik tombol kalau SUDAH kelihatan; kalau belum kelihatan,
            # LANGSUNG scroll ke bawah (tombol I UNDERSTAND/ACCEPT ada di paling bawah)
            # lalu klik. Tanpa nunggu lama.
            def _click_confirm_visible():
                for ct in confirmation_buttons:
                    try:
                        sel = self.device(textMatches="(?i)" + ct)
                        if sel.exists(timeout=0):
                            sel.click()
                            self.log_info(f"Clicked confirmation: {ct}")
                            return True
                    except Exception:
                        continue
                return False

            for _ in range(6):
                clicked = _click_confirm_visible()

                # Belum kelihatan -> langsung scroll ke bawah sekali, lalu klik lagi.
                if not clicked:
                    try:
                        scroller = self.device(scrollable=True)
                        if scroller.exists(timeout=0):
                            scroller.scroll.toEnd(max_swipes=4)
                            clicked = _click_confirm_visible()
                    except Exception:
                        pass

                self.dismiss_crash_dialogs()

                if clicked:
                    pause(0.8)
                    if self._verify_google_account_dumpsys(email):
                        self.log_info(f"Account terverifikasi tersimpan: {email}")
                        return True
                    continue

                # Tidak ada tombol sama sekali: cek akun; kalau belum, beri waktu layar muncul.
                if self._verify_google_account_dumpsys(email):
                    self.log_info(f"Account terverifikasi tersimpan: {email}")
                    return True
                pause(1)

            # Verifikasi akun tersimpan: cek singkat (maks ~6 detik), bukan 18 detik.
            for attempt in range(1, 5):
                if self._verify_google_account_dumpsys(email):
                    self.log_info(f"Account terverifikasi tersimpan: {email}")
                    return True
                pause(1.5)

            self.log_error(f"Google account failed dumpsys verification: {email}")
            return False
        except Exception as e:
            self.log_error(f"Error login_google for {email}: {e}")
            return False

    def has_paysafecard_payment_method(self, timeout=8):
        try:
            detected = self.exists_fast(timeout=timeout, textMatches="(?i)^paysafecard[:：].*")
            if detected:
                self.log_info("PaysafeCard payment method detected on Play Store Payment methods page")
            return detected
        except Exception as e:
            self.log_error(f"Error detecting PaysafeCard payment method: {e}")
            return False

    def fast_handle_popups(self):
        """Optimized popup handling with concurrent checking"""
        self.log_info("Checking for popups...")
        
        popup_elements = [
            ("Meet the Search tab", lambda: self.device.click(100, 100)),
            ("Got it", lambda: self.device(text="Got it").click()),
            ("No thanks", lambda: self.device(text="No thanks").click()),
            ("Skip", lambda: self.device(text="Skip").click()),
            ("Not now", lambda: self.device(text="Not now").click()),
            ("Maybe later", lambda: self.device(text="Maybe later").click()),
            ("Close", lambda: self.device(text="Close").click())
        ]
        
        for text, action in popup_elements:
            if self.device(text=text).exists(timeout=0):
                self.log_info(f"Found popup '{text}', handling...")
                action()
                pause(0.3)
                break
        
        self.log_info("Popup check completed")

    def fast_remove_google_account(self, email):
        """Hapus akun Google dengan navigasi & konfirmasi yang lebih tahan banting."""
        try:
            self.log_info("====== STARTING ACCOUNT REMOVAL ======")
            self.log_info(f"Target email: {email}")

            self.device.app_start("com.android.settings")
            pause(1)
            self.dismiss_crash_dialogs()

            # Buka "Passwords & accounts" (scroll cari kalau perlu, di-guard biar tidak error).
            if not self.device(text="Passwords & accounts").click_exists(timeout=action_timeout(3)):
                try:
                    self.device(scrollable=True).scroll.to(text="Passwords & accounts")
                except Exception:
                    pass
                if not self.device(text="Passwords & accounts").click_exists(timeout=action_timeout(2)):
                    self.log_error("Cannot find Passwords & accounts menu")
                    return False
            pause(1)

            # Klik akun email-nya.
            if not self.device(text=email).click_exists(timeout=action_timeout(4)):
                try:
                    self.device(scrollable=True).scroll.to(text=email)
                except Exception:
                    pass
                if not self.device(text=email).click_exists(timeout=action_timeout(3)):
                    # Tidak ada di daftar -> kemungkinan memang sudah terhapus.
                    if not self._verify_google_account_dumpsys(email):
                        self.log_info(f"Account {email} sudah tidak ada, anggap terhapus")
                        return True
                    self.log_error(f"Cannot find account {email}")
                    return False
            pause(1)

            # Klik "Remove account".
            removed = False
            for t in ["REMOVE ACCOUNT", "Remove account", "Hapus akun", "HAPUS AKUN"]:
                if self.device(text=t).click_exists(timeout=action_timeout(2)):
                    self.log_info(f"Clicked '{t}'")
                    removed = True
                    break
            if not removed:
                self.log_error("Cannot find Remove Account button")
                return False

            # Konfirmasi dialog hapus (tombol konfirmasi / android:id/button1).
            pause(0.5)
            confirmed = False
            for t in ["Remove account", "REMOVE ACCOUNT", "Hapus akun", "HAPUS AKUN", "OK"]:
                if self.device(text=t).click_exists(timeout=action_timeout(2)):
                    confirmed = True
                    break
            if not confirmed:
                self.device(resourceId="android:id/button1").click_exists(timeout=action_timeout(1))

            # Verifikasi terhapus pakai dumpsys (paling akurat), cek beberapa kali singkat.
            for _ in range(4):
                pause(1)
                if not self._verify_google_account_dumpsys(email):
                    self.log_info(f"Account {email} successfully removed")
                    return True
            self.log_error(f"Account {email} masih terdeteksi setelah remove")
            return False

        except Exception as e:
            self.log_error(f"Error removing account {email}: {e}")
            return False

    def open_play_store_with_retry(self, email):
        """Buka Play Store; kalau muncul error 'Try again' -> klik untuk coba lagi.
        Kalau setelah beberapa kali tetap gagal -> ganti VPN ExpressVPN ke lokasi UK
        lain lalu return False (akun akan di-retry worker dengan IP baru)."""
        tries = int(os.getenv("PSC_PLAYSTORE_TRIES", "3"))
        error_markers = [
            "Try again", "TRY AGAIN", "Retry", "Coba lagi", "COBA LAGI",
            "Something went wrong", "Terjadi kesalahan",
            "No connection", "Couldn't connect", "Tidak ada koneksi",
        ]
        for attempt in range(1, tries + 1):
            self.close_notification_shade()
            self.device.press("home")
            self.device.app_start("com.android.vending")
            deadline = time.time() + action_timeout(8)
            store_ready = False
            while time.time() < deadline:
                if (self.device(resourceId="com.android.vending:id/account_menu_item").exists(timeout=0)
                        or self.device(descriptionContains="Account").exists(timeout=0)
                        or self.device(text="Games").exists(timeout=0)
                        or self.device(text="For you").exists(timeout=0)):
                    store_ready = True
                    break
                # Deteksi & klik tombol "Try again"/error koneksi.
                clicked = False
                for marker in error_markers:
                    try:
                        sel = self.device(textContains=marker)
                        if sel.exists(timeout=0):
                            self.log_warn(f"Play Store error '{marker}' (attempt {attempt}), klik coba lagi")
                            sel.click_exists(timeout=action_timeout(1))
                            clicked = True
                            pause(2)
                            break
                    except Exception:
                        continue
                if not clicked:
                    pause(0.4)
            if store_ready:
                self.log_info(f"Play Store siap (attempt {attempt})")
                return True
            self.log_warn(f"Play Store belum siap (attempt {attempt}/{tries})")
            try:
                self.device.app_stop("com.android.vending")
                pause(1)
            except Exception:
                pass
        # Gagal setelah semua attempt -> auto-replace VPN ke lokasi UK lain.
        self.log_warn(f"Play Store gagal {tries}x untuk {email}, AUTO-REPLACE VPN ExpressVPN (UK lokasi lain)")
        switch_vpn_uk(self.log_warn)
        return False

    def switch_vpn_region(self, region):
        """Ganti lokasi app ExpressVPN DI DALAM emulator sesuai region order ('UK'/'FRANCE').
        Sesuai UI ExpressVPN: status 'Protected', kartu 'Selected Location' + tombol 'Change'."""
        region = str(region or "UK").upper()
        pkg = os.getenv("EXPRESSVPN_PKG", "com.expressvpn.vpn")
        # Nama negara untuk dicari di picker lokasi.
        search_map = {
            "UK": os.getenv("VPN_COUNTRY_UK", "United Kingdom"),
            "FRANCE": os.getenv("VPN_COUNTRY_FRANCE", "France"),
            "GERMANY": os.getenv("VPN_COUNTRY_GERMANY", "Germany"),
            "SPAIN": os.getenv("VPN_COUNTRY_SPAIN", "Spain"),
            "NETHERLANDS": os.getenv("VPN_COUNTRY_NETHERLANDS", "Netherlands"),
        }
        # Penanda di kartu 'Selected Location' untuk cek lokasi sekarang sudah sesuai region.
        match_map = {
            "UK": [m.strip() for m in os.getenv("VPN_MATCH_UK", "UK -,UK-,United Kingdom").split(",") if m.strip()],
            "FRANCE": [m.strip() for m in os.getenv("VPN_MATCH_FRANCE", "France -,France-,France").split(",") if m.strip()],
            "GERMANY": [m.strip() for m in os.getenv("VPN_MATCH_GERMANY", "Germany -,Germany-,Germany").split(",") if m.strip()],
            "SPAIN": [m.strip() for m in os.getenv("VPN_MATCH_SPAIN", "Spain -,Spain-,Spain").split(",") if m.strip()],
            "NETHERLANDS": [m.strip() for m in os.getenv("VPN_MATCH_NETHERLANDS", "Netherlands -,Netherlands-,Netherlands").split(",") if m.strip()],
        }
        # Daftar city pilihan per region (URUT prioritas). City pertama dicoba duluan.
        # France: UTAMAKAN 'France - Alsace'. Germany: utamakan Nuremberg. Spain: utamakan Barcelona.
        city_map = {
            "UK": [c.strip() for c in os.getenv("VPN_CITIES_UK", "").split(",") if c.strip()],
            "FRANCE": [c.strip() for c in os.getenv("VPN_CITIES_FRANCE", "France - Alsace").split(",") if c.strip()],
            "GERMANY": [c.strip() for c in os.getenv("VPN_CITIES_GERMANY", "Germany - Nuremberg,Germany - Frankfurt - 1,Germany - Berlin").split(",") if c.strip()],
            "SPAIN": [c.strip() for c in os.getenv("VPN_CITIES_SPAIN", "Spain - Barcelona,Spain - Barcelona - 2,Spain - Madrid,Spain - Valencia").split(",") if c.strip()],
            "NETHERLANDS": [c.strip() for c in os.getenv("VPN_CITIES_NETHERLANDS", "Netherlands - Rotterdam,Netherlands - Amsterdam,Netherlands - The Hague").split(",") if c.strip()],
        }
        # City yang DILARANG dipilih per region (kalau city utama gagal, jangan jatuh ke sini).
        # France: JANGAN pakai Paris.
        exclude_map = {
            "UK": [x.strip().lower() for x in os.getenv("VPN_EXCLUDE_UK", "").split(",") if x.strip()],
            "FRANCE": [x.strip().lower() for x in os.getenv("VPN_EXCLUDE_FRANCE", "Paris").split(",") if x.strip()],
            "GERMANY": [x.strip().lower() for x in os.getenv("VPN_EXCLUDE_GERMANY", "").split(",") if x.strip()],
            "SPAIN": [x.strip().lower() for x in os.getenv("VPN_EXCLUDE_SPAIN", "").split(",") if x.strip()],
            "NETHERLANDS": [x.strip().lower() for x in os.getenv("VPN_EXCLUDE_NETHERLANDS", "").split(",") if x.strip()],
        }
        country = search_map.get(region)
        matches = match_map.get(region, [])
        cities = city_map.get(region, [])
        excludes = exclude_map.get(region, [])
        if not country:
            self.log_warn(f"Region '{region}' tidak dikenal, lewati switch VPN")
            return False

        self.log_info(f"Switch VPN region -> {region} (cari '{country}')")
        # Pulihkan keyboard normal kalau run sebelumnya sempat ganti ke FastInputIME (hilangkan bar aneh).
        try:
            self.device.set_fastinput_ime(False)
        except Exception:
            pass
        def in_app():
            # CEK KETAT: app ExpressVPN benar-benar di DEPAN (foreground), bukan home launcher.
            # Wajib dipakai sebelum search -> hindari ketik di "Search games & apps" home.
            try:
                return self.device.app_current().get("package") == pkg
            except Exception:
                return False

        def app_ready():
            # App ExpressVPN terbuka & UI siap?
            if in_app():
                return True
            for t in ["Protected", "Unprotected", "Tap to connect", "VPN Location",
                      "Selected Location", "Smart Location"]:
                try:
                    if self.device(textContains=t).exists(timeout=0):
                        return True
                except Exception:
                    continue
            return False

        def ensure_in_app():
            # Pastikan kita di dalam ExpressVPN. Kalau di home/app lain -> buka appnya dulu.
            if in_app():
                return True
            self.log_warn("BUKAN di dalam app ExpressVPN (mungkin di home) -> buka app dulu")
            open_app()
            return in_app()

        def open_app():
            # Buka app ExpressVPN, RETRY sampai 3x kalau belum kebuka/siap.
            tries = int(os.getenv("VPN_OPEN_TRIES", "3"))
            for i in range(1, tries + 1):
                try:
                    self.close_notification_shade()
                    self.device.press("home")
                    self.device.app_start(pkg)
                    pause(action_timeout(5))
                except Exception as e:
                    self.log_warn(f"buka app ExpressVPN gagal (percobaan {i}/{tries}): {e}")
                if app_ready():
                    self.log_info(f"app ExpressVPN terbuka & siap (percobaan {i}/{tries})")
                    return True
                self.log_warn(f"app ExpressVPN belum siap -> retry buka ({i}/{tries})")
                try:
                    self.device.app_stop(pkg)  # force-stop lalu start ulang
                except Exception:
                    pass
                pause(1.5)
            self.log_warn(f"app ExpressVPN tidak bisa dibuka setelah {tries}x")
            return False

        def is_protected():
            try:
                return self.device(textContains="Protected").exists(timeout=0)
            except Exception:
                return False

        def on_target_location():
            for m in matches:
                try:
                    if self.device(textContains=m).exists(timeout=0):
                        return True
                except Exception:
                    continue
            return False

        def is_unable_to_connect():
            for t in ["Unable to Connect", "Unable to connect", "Couldn't connect",
                      "Could not connect", "Connection failed", "Tidak dapat terhubung"]:
                try:
                    if self.device(textContains=t).exists(timeout=0):
                        return True
                except Exception:
                    continue
            # Tombol 'Try Again' muncul = layar error koneksi.
            try:
                if self.device(text="Try Again").exists(timeout=0) or self.device(textContains="Try Again").exists(timeout=0):
                    return True
            except Exception:
                pass
            return False

        def dismiss_error():
            # Tutup layar error -> utamakan 'Close' (sesuai permintaan), lalu Cancel/OK.
            for t in ["Close", "Cancel", "OK", "Dismiss"]:
                try:
                    if self.device(text=t).click_exists(timeout=0):
                        self.log_info(f"tutup error VPN via '{t}'")
                        pause(1.0)
                        return
                except Exception:
                    continue

        def dismiss_promo():
            # Tutup kartu promo 'ExpressKeys / Install Now' kalau ada (best-effort).
            for strat in [
                lambda: self.device(description="Close").click_exists(timeout=0),
                lambda: self.device(descriptionContains="Close").click_exists(timeout=0),
                lambda: self.device(descriptionContains="Dismiss").click_exists(timeout=0),
            ]:
                try:
                    if strat():
                        pause(0.5)
                        return
                except Exception:
                    continue

        def already_correct():
            # Cek beberapa detik: kalau VPN SUDAH Protected & lokasi sesuai region -> tidak perlu ubah.
            deadline0 = time.time() + action_timeout(int(os.getenv("VPN_ALREADY_CHECK_SEC", "8")))
            while time.time() < deadline0:
                if is_protected() and on_target_location():
                    self.log_info(f"VPN sudah Protected & sesuai region {region}, skip ganti VPN")
                    self.device.press("home")
                    return True
                pause(1)
            return False

        select_retries = int(os.getenv("VPN_SELECT_RETRIES", "4"))  # total 5 percobaan switch city
        connect_wait = int(os.getenv("VPN_CONNECT_WAIT_SEC", "45"))

        def open_change():
            for t in ["Change", "Choose Location", "Choose location", "Change Location"]:
                try:
                    if self.device(textContains=t).click_exists(timeout=action_timeout(1)):
                        pause(1.5)
                        return True
                except Exception:
                    continue
            self.log_warn("Tombol 'Change' lokasi tidak ketemu, coba lanjut search")
            return False

        def search_box_ready():
            # Kotak ketik search sudah muncul? (EditText fokus / hint 'Search')
            try:
                if self.device(className="android.widget.EditText").exists(timeout=0):
                    return True
            except Exception:
                pass
            for hint in ["Search for country", "Search country", "Search"]:
                try:
                    if self.device(textContains=hint, className="android.widget.EditText").exists(timeout=0):
                        return True
                except Exception:
                    continue
            return False

        def open_search():
            # Kalau kotak search sudah terbuka, langsung pakai.
            if search_box_ready():
                return True
            # 1) Ikon kaca pembesar di pojok kanan ATAS (sesuai instruksi): description 'Search'.
            for sel in [
                lambda: self.device(description="Search").click_exists(timeout=action_timeout(1)),
                lambda: self.device(descriptionContains="Search").click_exists(timeout=action_timeout(1)),
                lambda: self.device(descriptionMatches="(?i).*search.*").click_exists(timeout=action_timeout(1)),
            ]:
                try:
                    if sel():
                        pause(0.7)
                        if search_box_ready():
                            return True
                except Exception:
                    continue
            # 2) resourceId umum tombol/ikon search.
            for sid in [f"{pkg}:id/menu_search", f"{pkg}:id/search", f"{pkg}:id/action_search",
                        f"{pkg}:id/searchView", f"{pkg}:id/search_src_text", f"{pkg}:id/search_button",
                        "android:id/search_button"]:
                try:
                    if self.device(resourceId=sid).click_exists(timeout=action_timeout(1)):
                        pause(0.7)
                        if search_box_ready():
                            return True
                except Exception:
                    continue
            try:
                if self.device(resourceIdMatches="(?i).*(search|cari).*").click_exists(timeout=action_timeout(1)):
                    pause(0.7)
                    if search_box_ready():
                        return True
            except Exception:
                pass
            # 3) Teks/hint 'Search for country'.
            for s in [
                lambda: self.device(textContains="Search for country").click_exists(timeout=action_timeout(1)),
                lambda: self.device(text="Search").click_exists(timeout=action_timeout(1)),
            ]:
                try:
                    if s():
                        pause(0.7)
                        return True
                except Exception:
                    continue
            return search_box_ready()

        def type_country():
            # Ketik nama negara pakai set_text (accessibility). JANGAN send_keys (memunculkan
            # bar keyboard FastInputIME yang bisa ganggu proses ngait).
            try:
                if self.set_text_fast(country, timeout=3, className="android.widget.EditText"):
                    return
            except Exception:
                pass
            try:
                self.device(focused=True).set_text(country)
            except Exception:
                pass

        def click_country_row():
            # Klik BARIS negara secara TEPAT. WAJIB className TextView supaya TIDAK meng-klik
            # kotak search (EditText) yang isinya teks "France"/"United Kingdom" yang barusan
            # diketik -> ini penyebab utama "salah negara".
            selectors = [
                dict(text=country, className="android.widget.TextView", clickable=True),
                dict(text=country, className="android.widget.TextView"),
                dict(textMatches=f"(?i)^{re.escape(country)}$", className="android.widget.TextView"),
                dict(textStartsWith=country, className="android.widget.TextView"),
            ]
            for sel in selectors:
                try:
                    if self.device(**sel).click_exists(timeout=action_timeout(3)):
                        return True
                except Exception:
                    continue
            return False

        tried_locations = set()  # city yang SUDAH dicoba (termasuk yang 'Try Again') -> jangan diulang.

        def is_excluded(label):
            # City terlarang (mis. Paris untuk France) -> jangan dipilih.
            low = (label or "").lower()
            return any(x in low for x in excludes)

        def discover_city_labels():
            # Kumpulkan label city negara ini dari hasil search (TextView mengandung nama negara).
            labels = []
            try:
                rows = self.device(textContains=country, className="android.widget.TextView")
                for i in range(rows.count):
                    try:
                        t = (rows[i].info.get("text") or "").strip()
                    except Exception:
                        t = ""
                    if t and t not in labels and not is_excluded(t):
                        labels.append(t)
            except Exception:
                pass
            # City spesifik (mengandung '-', mis. 'France - Alsace') didahulukan daripada baris negara umum.
            labels.sort(key=lambda s: (0 if "-" in s else 1))
            return labels

        def click_location(idx):
            # Pilih city negara order yang BELUM pernah dicoba. City yang 'Try Again' sudah
            # masuk tried_locations -> otomatis dilewati, pindah ke city LAIN yang (semoga) bisa.
            # City terlarang (Paris utk France) dilewati.
            pool = []
            for c in cities:            # daftar prioritas (.env / default Alsace) didahulukan
                if c not in pool and not is_excluded(c):
                    pool.append(c)
            for c in discover_city_labels():  # lalu city hasil search
                if c not in pool:
                    pool.append(c)
            for term in pool:
                if term in tried_locations:
                    continue
                try:
                    if self.device(text=term, className="android.widget.TextView").click_exists(timeout=action_timeout(3)):
                        tried_locations.add(term)
                        self.log_info(f"Pilih lokasi VPN: '{term}' (city ke-{len(tried_locations)}, belum pernah dicoba)")
                        return True
                except Exception:
                    continue
            # Semua city sudah dicoba / tidak ketemu -> fallback klik baris negara tepat.
            self.log_warn(f"Tidak ada city {country} baru yang belum dicoba (sudah coba: {sorted(tried_locations)})")
            return click_country_row()

        def switch_city_loop():
            # Coba switch ke beberapa city (beda tiap percobaan) sampai Protected & region terverifikasi.
            total_attempts = select_retries + 1
            for attempt in range(1, total_attempts + 1):
                try:
                    self.log_info(f"VPN switch ke {region} ('{country}') — percobaan {attempt}/{total_attempts}")
                    # WAJIB: pastikan di DALAM app ExpressVPN dulu (bukan home). Kalau di home -> buka app.
                    if not ensure_in_app():
                        self.log_warn("Masih belum di dalam app ExpressVPN -> skip percobaan ini")
                        continue
                    open_change()
                    # GATE: jangan search kalau ternyata ke-luar dari app (mis. balik ke home) -> hindari
                    # ketik di kotak 'Search games & apps' launcher. Buka app lagi kalau perlu.
                    if not ensure_in_app():
                        self.log_warn("Keluar dari app sebelum search -> buka app lagi, ulangi percobaan")
                        continue
                    open_search()
                    pause(0.8)
                    type_country()
                    pause(1.8)
                    # Tiap percobaan pilih city berbeda (idx = attempt-1).
                    if not click_location(attempt - 1):
                        self.log_warn(f"Lokasi '{country}' tidak ke-klik (percobaan {attempt})")
                    pause(action_timeout(4))

                    # Konfirmasi pindah lokasi kalau muncul dialog.
                    for c in ["Continue", "OK", "Yes", "Switch"]:
                        try:
                            if self.device(text=c).click_exists(timeout=0):
                                break
                        except Exception:
                            continue

                    # Tunggu sampai Protected ATAU muncul error 'Unable to Connect'.
                    deadline = time.time() + action_timeout(connect_wait)
                    protected = False
                    errored = False
                    while time.time() < deadline:
                        if is_protected():
                            protected = True
                            break
                        if is_unable_to_connect():
                            errored = True
                            break
                        pause(1.5)

                    # Error 'Unable to Connect' -> tutup (Close) & coba CITY LAIN di percobaan berikutnya.
                    if errored:
                        self.log_warn(f"'Unable to Connect' untuk {region} -> coba city lain (percobaan berikutnya)")
                        dismiss_error()
                        try:
                            self.device.press("back")
                            pause(1.2)
                        except Exception:
                            pass
                        continue

                    # VERIFIKASI negara benar. Protected tapi negara salah -> retry city lain.
                    pause(1.0)
                    if protected and on_target_location():
                        self.log_info(f"VPN Protected & sesuai region {region} (verified)")
                        self.device.press("home")
                        return True
                    if protected:
                        self.log_warn(f"VPN Protected TAPI negara TIDAK cocok {region} -> retry")
                    else:
                        self.log_warn(f"VPN belum Protected untuk {region} -> retry")
                    try:
                        self.device.press("back")
                        pause(1.2)
                    except Exception:
                        pass
                except Exception as e:
                    self.log_warn(f"Gagal switch VPN region (percobaan {attempt}): {e}")
                    try:
                        self.device.press("back")
                        pause(1)
                    except Exception:
                        pass
            return False

        # ===== OUTER LOOP: ulang dari OPEN (buka app + switch + CROSSCHECK region) sampai sesuai request.
        # Kalau di tengah app blank / ke-close / balik ke home -> putaran berikutnya buka app lagi & ulang.
        outer_tries = int(os.getenv("VPN_OUTER_TRIES", "3"))
        for rnd in range(1, outer_tries + 1):
            self.log_info(f"=== VPN region {region}: putaran {rnd}/{outer_tries} (open + switch + crosscheck) ===")
            tried_locations.clear()  # reset daftar city yang sudah dicoba tiap kali buka ulang
            # 1) Buka app ExpressVPN (retry 3x di dalam). Gagal -> ulang putaran (buka lagi).
            if not open_app():
                self.log_warn("buka app ExpressVPN gagal -> ulang dari open")
                continue
            dismiss_promo()
            # 2) CROSSCHECK awal: sudah Protected & region sesuai? -> langsung lanjut ngait.
            if already_correct():
                return True
            # 3) Switch city sampai Protected & region terverifikasi.
            if switch_city_loop():
                return True
            # 4) Region masih beda / app sempat blank-close -> ULANG dari open (putaran berikutnya).
            self.log_warn(f"region {region} BELUM sesuai setelah putaran {rnd} -> ulang dari OPEN app")
            try:
                self.device.press("home")
                pause(1)
            except Exception:
                pass

        self.log_warn(f"VPN GAGAL sesuai region {region} setelah {outer_tries} putaran (lanjut apa adanya)")
        try:
            self.device.press("home")
        except Exception:
            pass
        return False

    def open_payment_methods(self, email):
        """Buka Play Store app lalu navigasi ke Payment methods (cara reliable, tidak blank).
        Tunggu home siap + tangani 'Try again' sebelum navigasi."""
        tries = int(os.getenv("PSC_PLAYSTORE_TRIES", "3"))
        error_markers = [
            "Try again", "TRY AGAIN", "Retry", "Coba lagi", "COBA LAGI",
            "Something went wrong", "Terjadi kesalahan",
            "No connection", "Couldn't connect", "Tidak ada koneksi",
        ]
        ready_pay = ["Add PaysafeCard", "Payment methods", "Metode pembayaran"]

        def already_on_payment():
            # Sudah di halaman payment methods / Add PaysafeCard / paysafecard? -> jangan restart.
            for rm in ready_pay:
                try:
                    if self.device(textContains=rm).exists(timeout=0):
                        return True
                except Exception:
                    continue
            try:
                if self.device(textMatches="(?i)^paysafecard[:：].*").exists(timeout=0):
                    return True
            except Exception:
                pass
            return False

        def home_ready():
            try:
                return (
                    self.device(resourceId="com.android.vending:id/account_menu_item").exists(timeout=0)
                    or self.device(descriptionContains="Account").exists(timeout=0)
                    or self.device(text="Games").exists(timeout=0)
                    or self.device(text="For you").exists(timeout=0)
                )
            except Exception:
                return False

        def screen_is_blank():
            # Blank = hierarchy sangat pendek (tidak ada konten). Halaman payment/webview yang
            # ada isinya (walau teks tak terbaca) -> TIDAK blank, jadi jangan di-relaunch.
            try:
                h = self.device.dump_hierarchy(compressed=True) or ""
                return len(h) < int(os.getenv("PLAYSTORE_BLANK_HIER_LEN", "800"))
            except Exception:
                return False

        # Kalau SUDAH di halaman payment (mis. setelah login langsung nyangkut di sana),
        # langsung lanjut TANPA restart Play Store (biar tidak close & buka ulang sia-sia).
        if already_on_payment():
            self.log_info("Sudah di halaman payment methods, lanjut tanpa restart Play Store")
            return True

        for attempt in range(1, tries + 1):
            self.close_notification_shade()
            self.device.press("home")
            pause(0.5)
            # Force-stop dulu biar tidak resume layar blank/stuck, lalu buka app Play Store bersih.
            try:
                self.device.app_stop("com.android.vending")
                pause(1)
            except Exception:
                pass
            self.device.app_start("com.android.vending")
            # Tunggu sampai SIAP (home / payment) / blank kelamaan.
            deadline = time.time() + action_timeout(int(os.getenv("PLAYSTORE_WAIT_SEC", "25")))
            state = None  # "home" | "blank" | None(=ada konten tapi bukan home)
            blank_since = time.time()
            while time.time() < deadline:
                if already_on_payment():
                    self.log_info("Sudah di halaman payment saat menunggu, lanjut")
                    return True
                if home_ready():
                    state = "home"
                    break
                # Klik 'Try again' kalau error koneksi.
                clicked = False
                for em in error_markers:
                    try:
                        sel = self.device(textContains=em)
                        if sel.exists(timeout=0):
                            self.log_warn(f"Play Store error '{em}' (attempt {attempt}), klik coba lagi")
                            sel.click_exists(timeout=action_timeout(1))
                            clicked = True
                            pause(2)
                            break
                    except Exception:
                        continue
                if clicked:
                    blank_since = time.time()
                    continue
                # Relaunch HANYA kalau layar benar-benar BLANK (kosong). Kalau ada konten
                # (mis. halaman payment/webview yang teksnya tak terbaca) -> JANGAN relaunch.
                if not screen_is_blank():
                    blank_since = time.time()
                elif time.time() - blank_since > float(os.getenv("PLAYSTORE_BLANK_RELAUNCH_SEC", "12")):
                    self.log_warn(f"Layar blank (attempt {attempt}), buka ulang app Play Store")
                    self.close_notification_shade()
                    self.device.press("home")
                    try:
                        self.device.app_stop("com.android.vending")
                        pause(1)
                    except Exception:
                        pass
                    self.device.app_start("com.android.vending")
                    state = "blank"
                    blank_since = time.time()
                pause(0.5)

            if state == "home":
                # Beri waktu load/login sebelum navigasi (emulator lambat).
                warmup = float(os.getenv("PLAYSTORE_WARMUP_SEC", "5"))
                self.log_info(f"Play Store home siap, warm-up {warmup}s biar load/login dulu...")
                pause(warmup)
                self.fast_handle_popups()
            elif already_on_payment():
                return True
            elif screen_is_blank():
                self.log_warn(f"Play Store blank (attempt {attempt}/{tries}), restart")
                try:
                    self.device.app_stop("com.android.vending")
                    pause(1)
                except Exception:
                    pass
                continue
            else:
                # Ada konten tapi home tak terdeteksi (mungkin sudah di sub-page payment/webview)
                # -> coba lanjut NAVIGASI langsung, JANGAN restart (biar tidak close-buka terus).
                self.log_warn(f"Home tak terdeteksi tapi ada konten (attempt {attempt}), coba navigasi langsung")
                self.fast_handle_popups()

            # Klik menu Account (resource-id / text / description). Tanpa tap koordinat (berisiko).
            account_clicked = False
            for strat in [
                lambda: self.click_candidates(resource_ids=["com.android.vending:id/account_menu_item"], timeout=2),
                lambda: self.device(descriptionContains="Account").click_exists(timeout=action_timeout(2)),
                lambda: self.click_candidates(texts=["Account"], timeout=2),
            ]:
                try:
                    if strat():
                        account_clicked = True
                        break
                except Exception:
                    continue
            pause(1)

            # Navigasi: Payments & subscriptions -> Payment methods.
            for en_text, id_text in [
                ("Payments & subscriptions", "Pembayaran & langganan"),
                ("Payment methods", "Metode pembayaran"),
            ]:
                self.click_candidates(texts=[en_text, id_text], timeout=3)
                pause(1.5)

            # Cek halaman payment methods sudah terbuka.
            for rm in ready_pay:
                try:
                    if self.device(textContains=rm).exists(timeout=action_timeout(2)):
                        self.log_info(f"Payment methods siap (attempt {attempt}) [{rm}]")
                        return True
                except Exception:
                    continue
            try:
                if self.device(textMatches="(?i)^paysafecard[:：].*").exists(timeout=0):
                    self.log_info("PaysafeCard sudah terlihat di payment methods")
                    return True
            except Exception:
                pass
            self.log_warn(f"Payment methods belum kebuka (attempt {attempt}/{tries}), ulangi")

        self.log_error(f"Payment methods gagal dibuka untuk {email} setelah {tries}x")
        return False

    def fast_process_account(self, email, password, psc_email, psc_pass):
        try:
            self.log_info(f"====== STARTING NEW ACCOUNT PROCESS ======")
            self.log_info(f"Email: {email}, Paysafecard: {psc_email}")
            self.emit_progress(email, 5, "mulai proses")
            self.close_notification_shade()  # pastikan panel notifikasi/VPN tidak nyangkut
            self.device.press("home")

            login_result = self.login_google(email, password)
            if login_result == "NOT_REGISTERED":
                self.log_warn(f"Gsuite tidak terdaftar, skip tanpa proses penuh: {email}")
                self.save_not_registered(email, password)
                try:
                    self.device.press("back")
                    pause(0.3)
                    self.device.press("back")
                except Exception:
                    pass
                return "NOT_REGISTERED"
            if not login_result:
                self.log_error(f"Google login/register failed for {email}")
                return False
            self.emit_progress(email, 20, "login google berhasil")

            # Buka LANGSUNG halaman Payment methods via deep link (skip Play Store home
            # yang sering loading lama). Lebih cepat & tidak gampang gagal.
            self.emit_progress(email, 30, "buka payment methods")
            if not self.open_payment_methods(email):
                self.log_error(f"Payment methods tidak terbuka untuk {email}, hapus akun & retry")
                self.fast_remove_google_account(email)
                return False
            self.fast_handle_popups()
            self.emit_progress(email, 50, "payment methods siap")

            # Check if DOKU already exists
            if self.has_paysafecard_payment_method(timeout=3):
                self.log_info(f"✅ DOKU already exists on account {email}")
                self.emit_progress(email, 100, "paysafecard sudah ada")
                
                # Save successful account (DOKU sudah ada)
                self.save_successful_account_safe(email, password)
                
                # Remove account after finding existing DOKU
                if self.fast_remove_google_account(email):
                    self.log_info(f"====== PROCESS COMPLETED SUCCESSFULLY (EXISTING DOKU) ======")
                    return True
                else:
                    self.log_error(f"Failed to remove account {email} after finding existing DOKU")
                    return False
            
            # Fast DOKU addition. Posisi 'Add PaysafeCard' bisa beda per region (mis. Germany lebih
            # bawah di list) -> kalau belum kelihatan, SCROLL dulu sampai ketemu, baru klik.
            if not self.click_candidates(texts=["Add PaysafeCard"], timeout=4):
                try:
                    self.device(scrollable=True).scroll.to(text="Add PaysafeCard")
                except Exception:
                    pass
                if not self.click_candidates(texts=["Add PaysafeCard"], timeout=6):
                    self.log_error("Add PaysafeCard button not found (sudah scroll)")
                    self.fast_remove_google_account(email)
                    return False
                
            self.log_info("Add PaysafeCard button found and clicked")
            self.emit_progress(email, 60, "klik add paysafecard")
            pause(1)

            self.fast_click_text(["Continue", "CONTINUE", "Lanjutkan", "LANJUTKAN"])
            pause(1)
            
            # Input Paysafecard account used for connecting in Play Store.
            if not self.set_text_fast(psc_email, timeout=5, className="android.widget.EditText", instance=0):
                self.log_error("Cannot find PaysafeCard email input")
                self.fast_remove_google_account(email)
                return False
            if not self.set_text_fast(psc_pass, timeout=5, className="android.widget.EditText", instance=1):
                self.log_error("Cannot find PaysafeCard password input")
                self.fast_remove_google_account(email)
                return False
            self.emit_progress(email, 70, "isi akun paysafecard")
            pause(5)
            if self.exists_fast(timeout=2, text="Connect"):
                self.log_info("Connect button detected")
            pause(2)
            self.click_connect_button()
            self.emit_progress(email, 80, "klik connect")
            self.handle_connect_error_and_retry(max_retry=int(os.getenv("PSC_CONNECT_RETRY", "5")))
            pause(2)
            pause(2)

            # Wait for DOKU e-Wallet process
            if self.exists_fast(timeout=3, text="PaysafeCard"):
                self.device(text="PaysafeCard").wait_gone(timeout=action_timeout(3))

            # Fast complete sign up
            if self.exists_fast(timeout=5, text="Complete sign up"):
                self.device(text="Full name").click()
                pause(0.5)
                self.set_text_fast("indonesian", timeout=3, text="Full name")
                # Sebagian negara butuh pilih Province (mis. Spain -> Asturias). Pilih sesuai region.
                self.fill_signup_province()
                self.fast_click_text(["Save", "SAVE", "Simpan", "SIMPAN"])
                pause(3)

            pause(3)

            # Verifikasi. Kalau app sempat FORCE-CLOSE ke home (sering pas isi nama / after pay),
            # cek pertama bisa gagal karena Play Store tidak di halaman payment. PaysafeCard tetap
            # terikat ke AKUN walau app crash, jadi buka ulang payment methods lalu cek lagi.
            verified = self.has_paysafecard_payment_method(timeout=int(os.getenv("PSC_VERIFY_TIMEOUT", "12")))
            if not verified:
                reopen_tries = int(os.getenv("PSC_VERIFY_REOPEN_TRIES", "2"))
                for vtry in range(1, reopen_tries + 1):
                    self.log_warn(
                        f"PaysafeCard belum terdeteksi (mungkin app force-close ke home), "
                        f"buka ulang payment methods utk verifikasi ({vtry}/{reopen_tries}): {email}"
                    )
                    if self.open_payment_methods(email) and self.has_paysafecard_payment_method(timeout=8):
                        verified = True
                        break

            # Quick success verification - PENTING: Hanya save jika benar-benar berhasil
            if verified:
                self.log_info(f"✅ PaysafeCard successfully added to account {email}")
                self.emit_progress(email, 100, "berhasil validasi play store")

                # HANYA save ke file hasil jika DOKU benar-benar berhasil ditambahkan
                self.save_successful_account_safe(email, password)

                # Fast account removal after success
                if self.fast_remove_google_account(email):
                    self.log_info(f"====== PROCESS COMPLETED SUCCESSFULLY ======")
                    return True
                else:
                    self.log_error(f"Failed to remove account {email} after DOKU addition")
                    return False
            else:
                self.log_warn(f"❌ Failed to detect DOKU on account {email} - NOT SAVING TO RESULTS")
                self.fast_remove_google_account(email)
                return False

        except Exception as e:
            self.log_error(f"Error processing account {email}: {e}")
            self.fast_remove_google_account(email)
            return False

    def fill_signup_province(self):
        """Pilih 'Province' di form Complete sign up untuk region yang butuh (mis. Spain -> Asturias).
        Region diambil dari env REGION. Provinsi per region bisa di-override via .env."""
        region = os.getenv("REGION", "UK").upper()
        province_map = {
            "SPAIN": os.getenv("VPN_PROVINCE_SPAIN", "Asturias"),
            # tambah negara lain di sini kalau perlu, mis: "ITALY": os.getenv("VPN_PROVINCE_ITALY", "...")
        }
        province = province_map.get(region)
        if not province:
            return  # region ini tidak butuh province
        # Ada field Province/Provincia? Kalau tidak ada, lewati.
        has_field = False
        for lbl in ["Province", "Provincia", "Region", "State"]:
            try:
                if self.device(textContains=lbl).exists(timeout=action_timeout(2)):
                    has_field = True
                    break
            except Exception:
                continue
        if not has_field:
            return
        self.log_info(f"Complete sign up: pilih Province '{province}' (region {region})")
        # Buka dropdown Province.
        for opener in [
            lambda: self.device(text="Province").click_exists(timeout=action_timeout(2)),
            lambda: self.device(textContains="Province").click_exists(timeout=action_timeout(2)),
            lambda: self.device(textContains="Provincia").click_exists(timeout=action_timeout(2)),
            lambda: self.device(className="android.widget.Spinner").click_exists(timeout=action_timeout(2)),
        ]:
            try:
                if opener():
                    pause(1.0)
                    break
            except Exception:
                continue
        # Pilih provinsi target (scroll kalau belum kelihatan).
        selected = False
        try:
            if self.device(text=province).click_exists(timeout=action_timeout(2)):
                selected = True
            else:
                try:
                    self.device(scrollable=True).scroll.to(text=province)
                except Exception:
                    pass
                if self.device(text=province).click_exists(timeout=action_timeout(2)):
                    selected = True
        except Exception as e:
            self.log_warn(f"error pilih Province '{province}': {e}")

        # FALLBACK: kalau target tidak bisa dipilih / tidak ada -> pilih APA SAJA yang ada di
        # dropdown biar form valid & proses lanjut (jangan nyangkut karena field wajib).
        if not selected:
            self.log_warn(f"Province '{province}' tidak bisa dipilih -> pilih opsi apa saja yang ada")
            # 1) Item dropdown standar (Spinner) = CheckedTextView; klik item pertama yang ada teksnya.
            for cls in ["android.widget.CheckedTextView"]:
                try:
                    items = self.device(className=cls)
                    for i in range(items.count):
                        try:
                            t = (items[i].info.get("text") or "").strip()
                        except Exception:
                            t = ""
                        if t:
                            items[i].click()
                            self.log_info(f"Province fallback: pilih '{t}'")
                            selected = True
                            break
                except Exception:
                    pass
                if selected:
                    break
            # 2) Kalau masih belum, klik salah satu provinsi umum yang kelihatan.
            if not selected:
                for prov in ["Álava", "Albacete", "Alicante", "Almería", "Asturias",
                             "Ávila", "Badajoz", "Barcelona", "Madrid", "Valencia"]:
                    try:
                        if self.device(text=prov).click_exists(timeout=0):
                            self.log_info(f"Province fallback: pilih '{prov}'")
                            selected = True
                            break
                    except Exception:
                        continue
            if not selected:
                self.log_warn("Province fallback gagal: tidak ada opsi yang bisa dipilih")
        else:
            self.log_info(f"Province '{province}' dipilih")
        pause(0.8)

    def save_successful_account_safe(self, email, password):
        """Thread-safe method to save successful account with duplicate prevention"""
        with self.result_file_lock:
            try:
                # Check if email already exists in results file
                existing_emails = set()
                if os.path.exists(RESULT_FILE):
                    with open(RESULT_FILE, "r") as f:
                        for line in f:
                            if "|" in line:
                                existing_email = line.split("|")[0].strip()
                                existing_emails.add(existing_email)
                
                # Only save if email doesn't already exist
                if email not in existing_emails:
                    with open(RESULT_FILE, "a") as hasil:
                        hasil.write(f"{email}|{password}\n")
                    self.log_info(f"✅ Successfully saved account {email} to results file")
                else:
                    self.log_warn(f"⚠️ Account {email} already exists in results file, skipping save")
                    
            except Exception as e:
                self.log_error(f"Error saving successful account {email}: {e}")

    def save_not_registered(self, email, password):
        """Catat akun gsuite yang tidak terdaftar (email tidak ditemukan) ke file terpisah."""
        try:
            target = os.path.join(os.path.dirname(RESULT_FILE) or ".", "not-registered.txt")
            with self.result_file_lock:
                with open(target, "a") as f:
                    f.write(f"{email}|{password}\n")
            self.log_warn(f"Dicatat sebagai tidak terdaftar: {email}")
        except Exception as e:
            self.log_error(f"Gagal catat not-registered {email}: {e}")

    def click_connect_button(self):
        # 1. Cari tombol dengan text "Connect" (case-insensitive)
        if self.device(textMatches="(?i)connect").exists(timeout=0):
            self.device(textMatches="(?i)connect").click()
            self.log_info("Clicked Connect immediately by text")
            return True

        if self.device(textMatches="(?i)connect").exists(timeout=action_timeout(1)):
            self.device(textMatches="(?i)connect").click()
            self.log_info("Clicked Connect by text")
            return True

        # 2. Cari semua button di layar
        buttons = self.device(className="android.widget.Button")
        if hasattr(buttons, 'count') and buttons.count > 0:
            # Jika hanya satu button, klik saja
            if buttons.count == 1:
                buttons.click()
                self.log_info("Clicked the only button on screen")
                return True
            # Jika lebih dari satu, klik yang paling besar (lebar x tinggi)
            max_area = 0
            max_btn = None
            for i in range(buttons.count):
                btn = self.device(className="android.widget.Button", instance=i)
                info = btn.info
                if info and "bounds" in info:
                    b = info["bounds"]
                    area = (b["right"]-b["left"]) * (b["bottom"]-b["top"])
                    if area > max_area:
                        max_area = area
                        max_btn = btn
            if max_btn:
                max_btn.click()
                self.log_info("Clicked the largest button on screen")
                return True

        # 3. Fallback: klik koordinat tengah layar (atau posisi tombol Connect)
        w, h = self.device.window_size()
        self.device.click(w//2, int(h*0.7))  # 70% dari atas, biasanya tombol bawah
        self.log_info("Clicked fallback coordinate for Connect")
        return False

    def handle_connect_error_and_retry(self, max_retry=3):
        retry = 0
        while retry < max_retry:
            pause(2)
            # Deteksi popup error
            if self.exists_fast(timeout=2, text="We ran into a problem"):
                self.log_warn("Detected error popup after Connect, will close and retry...")
                # Klik tombol X (close)
                if self.device(description="Close").exists(timeout=0):
                    self.device(description="Close").click()
                elif self.device(description="Close").exists(timeout=action_timeout(1)):
                    self.device(description="Close").click()
                elif self.device(text="×").exists(timeout=0):
                    self.device(text="×").click()
                elif self.device(text="×").exists(timeout=action_timeout(1)):
                    self.device(text="×").click()
                else:
                    # Klik koordinat pojok kiri atas (X)
                    self.device.click(40, 60)
                pause(1)
                # Coba klik Connect lagi
                self.click_connect_button()
                retry += 1
            else:
                break
        if retry == max_retry:
            self.log_error("Connect failed after several retries due to repeated error popup.")

def load_emulator_ports():
    """Load emulator ports from .env file"""
    load_dotenv()  # Load .env file
    
    emulator_ports = []
    port_counter = 1
    
    while True:
        port_key = f"port{port_counter}"
        port_value = os.getenv(port_key)
        
        if port_value is None:
            break
            
        try:
            port = int(port_value)
            emulator_ports.append(port)
            print(f"Loaded {port_key}: {port}")
            port_counter += 1
        except ValueError:
            print(f"Invalid port value for {port_key}: {port_value}")
            break
    
    return emulator_ports

def load_accounts():
    with open(INPUT_FILE, "r") as akun_file:
        return [line.strip() for line in akun_file if line.strip()]

def load_used_doku_numbers():
    """Load already used DOKU numbers from file"""
    used_numbers = set()
    try:
        if os.path.exists("emu/used_doku_numbers.txt"):
            with open("emu/used_doku_numbers.txt", "r") as f:
                used_numbers = set(line.strip() for line in f if line.strip())
    except Exception as e:
        print(f"Error loading used DOKU numbers: {e}")
    return used_numbers

def split_list(lst, num_parts=2):
    """Split list into equal parts"""
    chunk_size = len(lst) // num_parts
    remainder = len(lst) % num_parts
    
    parts = []
    start = 0
    
    for i in range(num_parts):
        # Add one extra item to first 'remainder' chunks
        end = start + chunk_size + (1 if i < remainder else 0)
        parts.append(lst[start:end])
        start = end
    
    return parts

def remove_processed_account(email):
    try:
        with open(INPUT_FILE, "r") as f:
            accounts = f.readlines()
        
        with open(INPUT_FILE, "w") as f:
            for account in accounts:
                if not account.startswith(f"{email}|"):
                    f.write(account)
    except Exception as e:
        print(f"Error removing processed account: {e}")

def fast_process_emulator(automator):
    """Optimized emulator processing with better error handling"""
    if automator.device is None and not automator.connect():
        return

    # Ganti VPN ke region order ini (semua emulator pakai region yang sama per order).
    region = os.getenv("REGION", "UK")
    if os.getenv("VPN_SWITCH_ENABLED", "1") not in ("0", "false", "False"):
        try:
            automator.switch_vpn_region(region)
        except Exception as e:
            automator.log_warn(f"switch_vpn_region error (lanjut): {e}")

    processed_count = 0
    success_count = 0

    while True:
        try:
            email_data = automator.email_queue.get_nowait()
            if email_data is None:
                break
            email, password = email_data.split("|")
            processed_count += 1
            # Pastikan emulator masih konek; reconnect kalau stuck/terputus.
            if not automator.ensure_connected():
                automator.log_error(f"Emulator {automator.port} mati/stuck, hentikan emulator ini (akun sisa di-retry round berikutnya)")
                break
            # Use configured PaysafeCard credential.
            result = automator.fast_process_account(email, password, PSC_EMAIL, PSC_PASS)
            if result == "NOT_REGISTERED":
                # Tidak terdaftar -> skip permanen, hapus dari input biar tidak di-retry.
                remove_processed_account(email)
                automator.log_info(f"SKIP (tidak terdaftar): {email}")
            elif result:
                success_count += 1
                remove_processed_account(email)
                automator.log_info(f"SUCCESS: {success_count}/{processed_count} accounts processed successfully")
            else:
                automator.log_info(f"FAILED: {success_count}/{processed_count} accounts processed successfully")
        except Empty:
            break
        except Exception as e:
            automator.log_error(f"Error in processing: {e}")
            continue
    automator.log_info(f"FINAL STATS: {success_count}/{processed_count} accounts processed successfully")

def main():
    """Main function with optimized multi-threading and .env support"""
    # Load emulator ports from .env file
    emulator_ports = load_emulator_ports()
    
    if not emulator_ports:
        print("No emulator ports found in .env file!")
        print("Please create a .env file with port configurations:")
        print("port1=16512")
        print("port2=16448")
        print("port3=16416")
        print("port4=16480")
        return
    
    # Create emulator instances dynamically based on .env and keep only online devices.
    emulators = []
    for i, port in enumerate(emulator_ports, 1):
        emulator = EmulatorAutomator(port, f"EMU{i}")
        emulators.append(emulator)
    
    print(f"Created {len(emulators)} emulator instances:")
    for emu in emulators:
        print(f"  - {emu.name}: Port {emu.port}")

    online_emulators = []
    print("Checking online emulators before splitting accounts...")
    for emu in emulators:
        if emu.connect():
            online_emulators.append(emu)
        else:
            print(f"{emu.name}: Port {emu.port} offline, skipping")

    if not online_emulators:
        print("No online emulators available!")
        return

    if len(online_emulators) < len(emulators):
        print(f"Using {len(online_emulators)}/{len(emulators)} online emulators")
    
    # Load and split data
    accounts = load_accounts()
    
    if not accounts:
        print(f"No accounts found in {INPUT_FILE}!")
        return
        
    print(f"Loaded {len(accounts)} accounts")
    
    # Split data among emulators
    num_emulators = len(online_emulators)
    account_parts = split_list(accounts, num_emulators)
    
    # Fill queues for each emulator
    for i, emu in enumerate(online_emulators):
        for acc in account_parts[i]:
            emu.email_queue.put(acc)
        print(f"{emu.name}: {len(account_parts[i])} accounts")
    
    # Use ThreadPoolExecutor for better thread management
    print("Starting optimized multi-emulator processing...")
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=num_emulators) as executor:
        # Submit all emulator tasks
        future_to_emulator = {
            executor.submit(fast_process_emulator, emu): emu 
            for emu in online_emulators
        }
        
        # Wait for completion and handle any exceptions
        for future in as_completed(future_to_emulator):
            emu = future_to_emulator[future]
            try:
                future.result()
                print(f"{emu.name} completed successfully")
            except Exception as e:
                print(f"{emu.name} generated an exception: {e}")
    
    end_time = time.time()
    total_time = end_time - start_time
    print(f"\nAll emulators completed in {total_time:.2f} seconds")
    print(f"Average time per emulator: {total_time/num_emulators:.2f} seconds")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run PaysafeCard linker worker.")
    parser.add_argument("--input-file", default=os.getenv("PSC_INPUT_FILE", "gsuite.txt"))
    parser.add_argument("--result-file", default=os.getenv("PSC_RESULT_FILE", "Hasil-Gdoku.txt"))
    parser.add_argument("--psc-email", default=os.getenv("PSC_EMAIL", ""))
    parser.add_argument("--psc-pass", default=os.getenv("PSC_PASS", ""))
    args = parser.parse_args()

    INPUT_FILE = args.input_file
    RESULT_FILE = args.result_file
    os.makedirs(os.path.dirname(RESULT_FILE) or ".", exist_ok=True)

    PSC_EMAIL = args.psc_email
    PSC_PASS = args.psc_pass
    if not PSC_EMAIL or not PSC_PASS:
        print("PSC_EMAIL and PSC_PASS are required. Set them in .env or pass --psc-email/--psc-pass.")
        raise SystemExit(1)
    main()
