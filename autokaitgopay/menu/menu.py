import os
import subprocess
import sys


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(ROOT_DIR, "APP")
sys.path.insert(0, APP_DIR)

from logger import BANNER_MENU, C


def clear_screen():
    os.system("cls" if os.name == "nt" else "clear")


def run_script(filename):
    script_path = os.path.join(APP_DIR, filename)
    try:
        subprocess.run([sys.executable, script_path], cwd=ROOT_DIR, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"\n  {C.RED}X{C.RESET}  Error running {filename}: {exc}")
    except FileNotFoundError:
        print(f"\n  {C.RED}X{C.RESET}  File not found: {script_path}")
    input(f"\n  {C.GRAY}Press Enter to return to menu...{C.RESET}")


def main_menu():
    while True:
        clear_screen()
        print(BANNER_MENU)
        print(f"  {C.GREEN}1{C.RESET}  Connect GoPay To GSuite")
        print(f"  {C.CYAN}2{C.RESET}  Checker GoPay Linked")
        print(f"  {C.RED}0{C.RESET}  Exit")

        choice = input(f"\n  {C.YELLOW}?{C.RESET}  Pilih menu (0-2): ").strip()
        if choice == "1":
            clear_screen()
            run_script("app.py")
        elif choice == "2":
            clear_screen()
            run_script("checker.py")
        elif choice == "0":
            break
        else:
            input(f"\n  {C.RED}Pilihan tidak valid.{C.RESET} Press Enter...")


if __name__ == "__main__":
    main_menu()
