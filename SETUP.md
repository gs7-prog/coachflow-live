# CoachFlow: calendar, Google Meet and email setup

The calendar page works as soon as you replace `App.js` and `App.css`. Two things need one-time setup before they do real work:

1. **Google Meet links** (Google Cloud, about 10 minutes)
2. **Sending emails** (Resend and Vercel, about 20 minutes)

Do the Firestore security rules step (section 4) **before** you turn on the email sending.

---

## 1. Google Calendar and Meet links

The app signs the coach in with Google again and asks for permission to manage calendar events. It then creates the event and the Meet link directly through the Google Calendar API.

1. Open the Google Cloud console and select the project behind your Firebase app (`fitness-2e6c2`).
2. **APIs and Services > Library**: search for **Google Calendar API** and click **Enable**.
3. **APIs and Services > OAuth consent screen**:
   - Add the scope `https://www.googleapis.com/auth/calendar.events` (under Data access or Scopes).
   - While the app is in **Testing**, add your own Google account (and any other coach) under **Test users**.
4. In the app, open **Calendar** and click **Connect Google Calendar**.

Things to know:

- Google shows an "unverified app" warning while the app is in Testing. Click **Advanced** and continue. To remove the warning for other coaches, the app needs Google verification, because the calendar scope is a sensitive scope.
- The connection lasts about an hour and lives in the browser only. When it expires, the app asks you to connect again. Nothing is stored on a server.
- If you do not connect, you can still paste an existing Meet link when scheduling.

---

## 2. Sending emails (Resend and Vercel)

Browsers cannot send email or run on a schedule, so a small function on Vercel does it once a day. The app saves each message (the exact text you previewed) in Firestore, and the function sends whatever is due.

### 2.1 Install the dependency

In your project folder:

```
npm install firebase-admin
```

### 2.2 Add the files

Copy these into the root of your project (next to `package.json`):

- `api/send-reminders.js`
- `vercel.json` (if you already have one, merge the `crons` entry into it)

### 2.3 Resend

1. Create an account at resend.com and **verify a sending domain** (or the address you will send from).
2. Create an **API key**.

### 2.4 Firebase service account

1. Firebase console > Project settings > **Service accounts** > **Generate new private key**.
2. Open the downloaded JSON file. You will paste its whole content into a Vercel variable. Never commit this file to GitHub.

### 2.5 Vercel environment variables

Project > Settings > Environment Variables:

| Name | Value |
|------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | The full content of the service account JSON |
| `RESEND_API_KEY` | Your Resend API key |
| `FROM_EMAIL` | The verified sending address, for example `noreply@yourdomain.com` |
| `CRON_SECRET` | A long random string you make up |
| `TIMEZONE` | Optional. Defaults to `Europe/Tallinn` |

Redeploy after adding them.

### 2.6 Test it safely first

Run a dry run. It lists what would be sent and sends nothing:

```
curl -H "Authorization: Bearer YOUR_CRON_SECRET" "https://YOUR-APP.vercel.app/api/send-reminders?dry=1"
```

When the list looks right, the daily cron (05:00 UTC, which is 07:00 or 08:00 in Estonia) sends for real. Vercel adds the `CRON_SECRET` header to its own cron calls automatically. Hobby plans can run a cron job once a day, which is what this uses.

How sending works:

- A message goes out on the day it is scheduled for. If you schedule something for today after the daily run, it goes out the next morning.
- Coach reminders go to the email of the coach's account. Client emails go to the email of the client's own account, and only after the client has joined.
- Birthday and Christmas messages repeat every year. Partner introductions are sent once.
- Messages more than 3 days overdue are marked expired instead of being sent late.

---

## 3. Using the new features

- **Add feedback to calendar**: on any active client's page, on their card, or from the Calendar page. Pick Google Meet or email, check the previews, and add it. You get a reminder email and the client gets their email on the day.
- **Automated messages** (client page): set the client's date of birth, then switch on birthday wishes, Christmas wishes or a partner introduction. You preview the email and confirm that the client agreed to receive it. The confirmation is saved on the client record.
- **Inactive** (no check-in for 30 days) and **Completed** appear as views on the Client List. Mark a programme completed from the client page.

On consent: in the EU, marketing-style emails (such as the partner introductions) need the person's own agreement. The confirmation box records that you vouch for it, but the safest approach is to get the agreement from the client in writing (for example a chat message or form) and keep it.

---

## 4. Firestore security rules (do this before sending real email)

Your current rules let any signed-in user read and write everything. With sending switched on, that is risky: another signed-in user could write email documents into the database. The function protects recipients (it only mails the coach, or that coach's own joined clients), but you should still restrict access.

The new collections are `calendarEvents`, `scheduledEmails`, `paymentMethods`, `payments`, `subscriptions` and `adminMessages`. A starting point for them (adapt to your existing rules, and remove any wildcard `match /{document=**}` that allows everything, because rules combine with OR):

```
match /calendarEvents/{id} {
  allow create: if request.auth != null && request.resource.data.coachId == request.auth.uid;
  allow read, update, delete: if request.auth != null && resource.data.coachId == request.auth.uid;
}
match /scheduledEmails/{id} {
  allow create: if request.auth != null && request.resource.data.coachId == request.auth.uid;
  allow read, update, delete: if request.auth != null && resource.data.coachId == request.auth.uid;
}
match /paymentMethods/{id} {
  allow create: if request.auth != null && request.resource.data.coachId == request.auth.uid;
  allow read, update, delete: if request.auth != null && resource.data.coachId == request.auth.uid;
}
match /payments/{id} {
  allow create: if request.auth != null && request.resource.data.coachId == request.auth.uid;
  allow read: if request.auth != null && resource.data.coachId == request.auth.uid;
}
match /subscriptions/{coachId} {
  allow read, write: if request.auth != null && request.auth.uid == coachId;
}
match /adminMessages/{id} {
  allow create: if request.auth != null && request.resource.data.coachId == request.auth.uid;
}
```

The `clients`, `users`, `profiles` and `weeklyCheckIns` collections also need proper rules before real clients use the app. The server function reads everything through the Firebase Admin SDK, so these rules do not affect it.

---

## 5. Test checklist

1. Calendar page opens from the top menu and the sidebar.
2. Connect Google Calendar, schedule a Google Meet feedback for tomorrow. A Meet link appears in the event, and the client receives a Google invite.
3. Open the event: it shows "Scheduled" for both emails.
4. Run the dry run: it lists the reminder (and the client email if due).
5. Switch on birthday wishes for a test client, then run the dry run on their birthday date.
6. Mark a test client's programme as completed: it moves to the Completed view and their pending reminders are cancelled.
