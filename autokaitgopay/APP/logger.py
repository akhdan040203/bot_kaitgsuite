"""
Beautiful Logger for GSuite x GoPay Bot
Provides colored, timestamped, structured logging with progress tracking.
"""

import os
import sys
import threading
from datetime import datetime
from colorama import Fore, Back, Style, init

init(autoreset=True)

# ═══════════════════════════════════════════════════════
# Color Palette
# ═══════════════════════════════════════════════════════
class C:
    """Color shortcuts"""
    CYAN    = Fore.CYAN
    GREEN   = Fore.GREEN
    RED     = Fore.RED
    YELLOW  = Fore.YELLOW
    MAGENTA = Fore.MAGENTA
    WHITE   = Fore.WHITE
    BLUE    = Fore.LIGHTBLUE_EX
    GRAY    = Fore.LIGHTBLACK_EX
    BOLD    = Style.BRIGHT
    RESET   = Style.RESET_ALL
    DIM     = Style.DIM

# ═══════════════════════════════════════════════════════
# Progress Tracker (thread-safe)
# ═══════════════════════════════════════════════════════
class ProgressTracker:
    def __init__(self, total=0):
        self.total = total
        self.success = 0
        self.failed = 0
        self.processing = 0
        self._lock = threading.Lock()

    def start_one(self):
        with self._lock:
            self.processing += 1

    def mark_success(self):
        with self._lock:
            self.success += 1
            self.processing -= 1

    def mark_failed(self):
        with self._lock:
            self.failed += 1
            self.processing -= 1

    @property
    def done(self):
        return self.success + self.failed

    @property
    def progress_bar(self):
        if self.total == 0:
            return ""
        filled = int((self.done / self.total) * 20)
        bar = "█" * filled + "░" * (20 - filled)
        pct = int((self.done / self.total) * 100)
        return f"{C.GRAY}[{C.GREEN}{bar}{C.GRAY}] {C.WHITE}{pct}%{C.RESET}"

    @property
    def stats(self):
        return (
            f"{C.GREEN}✓{self.success}{C.RESET} "
            f"{C.RED}✗{self.failed}{C.RESET} "
            f"{C.YELLOW}⧗{self.processing}{C.RESET} "
            f"{C.GRAY}({self.done}/{self.total}){C.RESET}"
        )

# Global tracker
progress = ProgressTracker()

# ═══════════════════════════════════════════════════════
# Timestamp
# ═══════════════════════════════════════════════════════
def _ts():
    return datetime.now().strftime("%H:%M:%S")

# ═══════════════════════════════════════════════════════
# Log Functions
# ═══════════════════════════════════════════════════════
def log_info(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.CYAN}ℹ{C.RESET}  {C.GRAY}[{task_id}]{C.RESET}  {msg}")

def log_success(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.GREEN}✓{C.RESET}  {C.GRAY}[{task_id}]{C.RESET}  {C.GREEN}{msg}{C.RESET}")

def log_fail(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.RED}✗{C.RESET}  {C.GRAY}[{task_id}]{C.RESET}  {C.RED}{msg}{C.RESET}")

def log_warn(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.YELLOW}⚠{C.RESET}  {C.GRAY}[{task_id}]{C.RESET}  {C.YELLOW}{msg}{C.RESET}")

def log_step(task_id, step, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.MAGENTA}→{C.RESET}  {C.GRAY}[{task_id}]{C.RESET}  {C.BOLD}{C.WHITE}{step}{C.RESET} {C.GRAY}│{C.RESET} {msg}")

def log_otp(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.YELLOW}🔑{C.RESET} {C.GRAY}[{task_id}]{C.RESET}  {C.YELLOW}{msg}{C.RESET}")

def log_lock(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.BLUE}🔒{C.RESET} {C.GRAY}[{task_id}]{C.RESET}  {C.BLUE}{msg}{C.RESET}")

def log_unlock(task_id, msg):
    print(f"  {C.GRAY}{_ts()}{C.RESET}  {C.GREEN}🔓{C.RESET} {C.GRAY}[{task_id}]{C.RESET}  {C.GREEN}{msg}{C.RESET}")

def log_progress():
    print(f"\n  {progress.progress_bar}  {progress.stats}\n")

# ═══════════════════════════════════════════════════════
# Banners & Separators
# ═══════════════════════════════════════════════════════
BANNER_CONNECT = f"""
{C.CYAN}{C.BOLD}
  ╔══════════════════════════════════════════════════╗
  ║     🔗  GSuite × GoPay Auto Connector  🔗       ║
  ║                                                  ║
  ║   Login → Add GoPay → OTP → PIN → Simpan        ║
  ╚══════════════════════════════════════════════════╝{C.RESET}
"""

BANNER_CHECKER = f"""
{C.MAGENTA}{C.BOLD}
  ╔══════════════════════════════════════════════════╗
  ║     🔍  GoPay Linked Checker  🔍                 ║
  ║                                                  ║
  ║   Login → Check Payment Methods → Sort           ║
  ╚══════════════════════════════════════════════════╝{C.RESET}
"""

BANNER_MENU = f"""
{C.CYAN}{C.BOLD}  ╔══════════════════════════════════════════════════╗
  ║                                                  ║
  ║    ⚡  Bot Automisasi GSuite × GoPay  ⚡         ║
  ║                                                  ║
  ╚══════════════════════════════════════════════════╝{C.RESET}
"""

def print_divider(label="", color=C.GRAY):
    if label:
        line = f"  {color}{'─'*10} {label} {'─'*10}{C.RESET}"
    else:
        line = f"  {color}{'─'*50}{C.RESET}"
    print(line)

def print_config(items: dict):
    """Print config items in a nice box"""
    print(f"  {C.GRAY}┌──────────────────────────────────────┐{C.RESET}")
    for key, value in items.items():
        print(f"  {C.GRAY}│{C.RESET}  {C.WHITE}{key:<18}{C.RESET} {C.CYAN}{value}{C.RESET}")
    print(f"  {C.GRAY}└──────────────────────────────────────┘{C.RESET}")

def print_summary(title, stats: dict):
    """Print a final summary box"""
    print(f"\n  {C.BOLD}{C.WHITE}{'═'*50}{C.RESET}")
    print(f"  {C.BOLD}{C.WHITE}  {title}{C.RESET}")
    print(f"  {C.WHITE}{'─'*50}{C.RESET}")
    for label, (value, color) in stats.items():
        icon = "✓" if color == C.GREEN else ("✗" if color == C.RED else "●")
        print(f"  {color}  {icon} {label:<30} {value}{C.RESET}")
    print(f"  {C.BOLD}{C.WHITE}{'═'*50}{C.RESET}\n")

def task_label(index, email):
    """Create a short task label like T0:user@domain"""
    user = email.split('@')[0][:8]
    domain = email.split('@')[1].split('.')[0][:6] if '@' in email else ''
    return f"T{index}:{user}@{domain}"
