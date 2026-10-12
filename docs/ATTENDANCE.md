# Attendance: punch in and out of Zoho People

> **Switched off for now.** Zoho People refuses API access to our roles ("Sorry! your role is not allowed to access api's"), so this release has no attendance: no timer, no Workday box, no pop-up, no commands or settings. The code is kept. To switch it back on once a Zoho People admin allows API access for your role: set `ATTENDANCE` to `true` in `extension.js`, and put the commands and settings from `dev/attendance.contributes.json` back into `package.json`. A Zoho sign-in made before is kept and works again.
>
> The rest of this page describes the feature as it works when switched on.

Ajwain takes care of your Zoho People punches on workdays. When you open VS Code in the morning, a pop-up asks whether to punch you in (or, if you prefer, it punches you in at 09:00 by itself). At 18:00 it punches you out. It shows your day as it goes: a timer in the status bar and a **Workday** box in the sidebar and on Today. It doesn't watch what you're doing. Being away from the keyboard never punches you out.

## Set it up (about two minutes, once)

You connect with a Zoho **Self Client**: a private key you create for yourself in Zoho's API Console. No admin is needed.

1. In VS Code, run **Ajwain: Connect Zoho People**, or click **Connect Zoho People** in the Workday box.
2. Pick your Zoho data centre: the one in the address you open Zoho People at. `people.zoho.in` is India.
3. Choose **Open the API Console**. In the console:
   - Choose **Self Client**, then **Create**.
   - On the **Client Secret** tab, copy the **Client ID** and the **Client Secret**.
   - On the **Generate Code** tab, enter the scope `ZOHOPEOPLE.attendance.ALL`, choose **10 minutes**, add any description, and click **Create**. Copy the code.
4. Back in VS Code, paste the client ID, the client secret and the code. Then confirm your email in Zoho People.

That's it. The status bar now shows **In** or **Out**.

The code works once and only for a few minutes. If it has expired, generate a new one and run **Connect Zoho People** again.

## How you're punched in and out

You choose, separately for punching in and punching out. Click the timer in the status bar and pick **Punch-in** or **Punch-out**, or set `ajwain.attendance.punchIn` and `ajwain.attendance.punchOut`.

**Punching in:**

| Choice | What happens |
| --- | --- |
| **Ask me when VS Code opens** (the default) | When you open VS Code on a workday, or come back to it, and you haven't punched in yet, a pop-up says "Good morning, Sam. Punch in to Zoho People?". **Punch in** punches you in, at that moment. **Not today** leaves it, and you aren't asked again that day. It asks from 3 hours before your in time (06:00) until your out time. |
| **Automatically at 09:00** | Punches you in at 09:00. If VS Code starts later, it punches you in then, at the real time. It never backdates. |
| **Only when I punch in** | Never punches you in, never asks. |

**Punching out:**

| Choice | What happens |
| --- | --- |
| **Automatically at 18:00** (the default) | Punches you out, timed 18:00. If VS Code was busy or asleep at 18:00 and notices later that evening, the punch-out is still timed 18:00. |
| **Ask me at 18:00** | From 18:00, a pop-up asks whether to punch out, once. **Punch out** punches you out at that moment. |
| **Only when I punch out** | Never punches you out, never asks. |

Pop-ups only appear while you're at VS Code. If you're away at 18:00, you're asked when you come back.

Whichever you choose:

| When | What Ajwain does |
| --- | --- |
| You punch out yourself, for lunch say | Leaves you out. Punching back in is yours: it doesn't ask or punch you in again that day. |
| You punch in yourself after 18:00 | Leaves you in. Punching out is yours. |
| You were still punched in from an earlier day (VS Code was closed at 18:00) | Asks once: **Punch out at 18:00** that day, **Punch out now**, or **Leave it**. Not when punching out is **Only when I punch out**. |
| Weekends, or days not in `ajwain.attendance.days` | Nothing. |

**Your punches elsewhere count.** Ajwain checks Zoho before every punch and every 15 minutes in between. If you punched in on the Zoho app or a biometric device, it won't punch you in again.

**Several VS Code windows** share one attendance state, and only one of them punches.

If a punch fails (no network, Zoho down), Ajwain tries again every 5 minutes and tells you once.

## Seeing your day

- **The status bar:** `In 5:14:02` counts up while you're in; `Out · 6:02 today` when you're out.
- **The Workday box,** in the sidebar and on Today: the same timer, when you punched in and how long to 18:00, a bar from 09:00 to 18:00 with the stretches you were in and a mark for now, and one button to punch in or out.

## By hand

Click the status bar item (or run **Ajwain: Attendance (Zoho People)…**) for:

- punch in or out now;
- choose how you're punched in, and how you're punched out;
- check with Zoho People now;
- open Zoho People;
- attendance settings;
- disconnect.

The Workday box's button punches too.

## Claude can't punch for you

Punching is something only you do, by clicking in VS Code. Claude Code is kept out of it on purpose, three ways:

- **The `ajwain` CLI has no attendance commands.** `ajwain punch` and the like refuse, with exit code 2.
- **The [Claude Code skill](SKILL.md)** tells Claude that attendance is off limits, even if you ask.
- **A guard hook** (`skills/pm-tickets/attendance-guard.mjs`) blocks Claude's tool calls that would get around that: calling Zoho's servers, reading the stored Zoho keys, changing the `ajwain.attendance.*` or `ajwain.zoho.*` settings, driving the desktop, or switching the guard off. Install it as described in [SKILL.md](SKILL.md#the-attendance-guard).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `ajwain.attendance.punchIn` | `ask` | `ask`: a pop-up when you open VS Code. `auto`: at the in time. `off`: only by hand. |
| `ajwain.attendance.punchOut` | `auto` | `auto`: at the out time. `ask`: a pop-up from the out time. `off`: only by hand. |
| `ajwain.attendance.in` | `09:00` | Your day's start (24-hour). |
| `ajwain.attendance.out` | `18:00` | Your day's end. |
| `ajwain.attendance.days` | Monday to Friday | Your workdays. |
| `ajwain.zoho.region` | `in` | Your Zoho data centre. |
| `ajwain.zoho.email` | | Your email in Zoho People: the employee the punches are for. |

## What's sent, and where it's kept

- **Sent to Zoho:** your email in Zoho People and the punch times, to your own data centre. Nothing else about your work leaves VS Code.
- **Kept on your machine:**
  - the client ID, the client secret and the refresh token, in VS Code's secret storage (your system keychain);
  - your punch state, in VS Code's storage.
- **Disconnecting** (**Ajwain: Disconnect Zoho People**) deletes the stored keys. To revoke access on Zoho's side as well, delete the Self Client in the API Console.

## If something's off

| Message | What to do |
| --- | --- |
| "the code was wrong or expired" | Codes last a few minutes. Generate a new one and connect again. |
| "the client id or secret is wrong, or belongs to another data centre" | Check you picked the data centre you created the Self Client in. |
| "Employee not found" or similar from Zoho | `ajwain.zoho.email` must be your email exactly as Zoho People has it. |
| A permission error | Your Zoho People role needs the Check-in/Check-out permission. Ask your Zoho People admin. |
| "sign-in expired or was revoked" | Run **Connect Zoho People** again. |

Ajwain writes each punch, and anything that went wrong, to **View → Output → Ajwain**. When Zoho refuses something, Zoho's whole reply is there too ("Zoho replied: …"). Its error code and message say what Zoho wants.

Times are sent in your computer's time zone. If Zoho People's organisation runs in a different time zone, check the first few punches in Zoho.
