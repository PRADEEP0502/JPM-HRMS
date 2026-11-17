# JPM WhatsApp bot

Posts the latest attendance report's **late arrivals** and **missing punches** to a WhatsApp group once a
day, tagging each department's HOD and the employee. HR sets the group name, send time, HODs and mobile
numbers in the app under **Settings → WhatsApp alerts**.

This uses WhatsApp Web (unofficial). Use a dedicated company number, not a personal one: WhatsApp can
ban numbers that it sees as automated.

## One-time setup

1. **Server:** in the Render dashboard, add the environment variable `WA_BOT_TOKEN` with a long random
   value (e.g. 40 random letters and digits) and redeploy.
2. **Office PC:** install Node.js 18 or newer (https://nodejs.org).
3. Copy this `whatsapp-bot` folder to the PC. Copy `config.example.json` to `config.json` and fill in:
   - `apiUrl`: the backend URL (the same one the app uses, e.g. `https://jpm-hrms.onrender.com`)
   - `botToken`: the same value as `WA_BOT_TOKEN`
4. Double-click `start-bot.bat`. A QR code appears. On the bot's phone open WhatsApp →
   **Linked devices → Link a device** and scan it. The login is saved in the `auth` folder.
5. Add that WhatsApp number to the group. In the app, under **Settings → WhatsApp alerts**, type the
   exact group name, pick the send time, turn on **Send daily alerts** and save.
6. To start the bot automatically after a restart: press Win+R, type `shell:startup`, and put a shortcut
   to `start-bot.bat` in that folder.

## Daily behaviour

- Every minute the bot checks the server. After the send time it posts the newest imported report
  (from the last 3 days) that has not been posted yet, then marks it as sent. Each report is posted once.
- If the report is imported after the send time, it is posted as soon as it is imported.
- Employees or HODs without a mobile number appear by name only (no tag).
- `npm run preview` prints the next message without sending it.
- If WhatsApp logs the bot out, delete the `auth` folder and run `start-bot.bat` again to rescan.
