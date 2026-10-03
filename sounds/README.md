# Windows sounds

This folder holds the real sound files from a Windows 11 PC's
`C:\Windows\Media` folder. The Windows games play them for the same events
Windows does. Nothing needs configuring: the games look for the files by
their Windows names.

| Event in the game | File |
|---|---|
| Desktop appears after booting or setup | `Windows Logon.wav` (see note below) |
| Signing in on the lock screen | `Windows Unlock.wav` |
| Shut down or restart | `Windows Shutdown.wav` |
| Letting go of the volume slider | `Windows Background.wav` |
| A notification pops up | `Windows Notify System Generic.wav` |
| Something went wrong (wrong PIN, bad code, error box) | `Windows Critical Stop.wav` |
| An "are you sure?" box | `Windows Exclamation.wav` |
| An ordinary message box | `Windows Background.wav` |
| Clicking toggles and buttons | `Windows Navigation Start.wav` |
| A window opens | `Windows Menu Command.wav` |
| Minimise / maximise | `Windows Minimize.wav` / `Windows Restore.wav` |
| Emptying the Recycle Bin | `Windows Recycle.wav` |
| Virus PC: User Account Control prompt | `Windows User Account Control.wav` |
| Virus PC: a virus got in | `Windows Hardware Fail.wav` |
| Virus PC: a pop-up ad | `Windows Pop-up Blocked.wav` |
| Virus PC: health drops low / critical | `Windows Battery Low.wav` / `Windows Battery Critical.wav` |

**About the startup sound.** The `Windows Startup.wav` in the Media folder is
a near-silent 0.2-second placeholder; Windows keeps the real startup chime
inside a system file, not as a .wav. So for now the games use
`Windows Logon.wav`, which is the older Windows 7 jingle. To get the real
Windows 11 chime, do either of these and the games pick it up automatically:

- Save a recording of the Windows 11 startup sound here as `startup.mp3`
  (or `.wav`, `.ogg`, `.m4a`), or
- Extract it from Windows and save it here as `Windows Startup.wav`,
  replacing the placeholder. With Resource Hacker, open
  `C:\Windows\SystemResources\imageres.dll.mun`, look in the WAVE folder for
  the clip a couple of seconds long, and save it as a .wav.

These sounds are Microsoft's and are here for this family's own game.
