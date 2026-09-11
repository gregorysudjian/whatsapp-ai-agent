# WhatsApp templates for appointment reminders

A reminder reaches a customer who may not have written in days. Outside WhatsApp's
24-hour window **only a template Meta has approved** is delivered, so reminders need one
template per language you want to remind in. Submit it once; approval usually takes
minutes, sometimes a day.

## Submit it

1. Open **Meta Business Manager → WhatsApp Manager → Message templates → Create template**
   (for the WhatsApp Business Account that owns the business's number).
2. **Category:** Utility. **Type:** Default (text).
3. **Name:** `appointment_reminder` (or anything in lowercase letters, digits and `_` —
   but then type the same name in the dashboard, Agent settings → Reminders).
4. **Language:** one per template (English, French, Arabic). You can add all three to the
   same name.
5. **Body:** copy the text below for that language, exactly, including `{{1}}` `{{2}}` `{{3}}`.
   Meta asks for sample values: `Sam`, `Tuesday, September 15`, `10:00`.
6. **Buttons:** add **Quick reply** buttons, in this order — first Confirm, then Cancel.
   The order matters: the dashboard puts `confirm:<booking>` on the first and
   `cancel:<booking>` on the second.
7. Submit. When the status shows **Active**, go to the dashboard: **Agent settings →
   Reminders**, switch reminders on, pick the language you submitted, save.

The variables the dashboard fills in:

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | the customer's name on the booking | Sam |
| `{{2}}` | the day, written out in the template's language | Tuesday, September 15 / mardi 15 septembre |
| `{{3}}` | the start time, 24-hour, business time | 10:00 |

## English (`en`)

**Body**

```
Hi {{1}}, this is a reminder of your appointment on {{2}} at {{3}}. Can you still make it?
```

**Buttons (quick reply):** `Confirm` · `Cancel`

## French (`fr`)

**Body**

```
Bonjour {{1}}, petit rappel de votre rendez-vous le {{2}} à {{3}}. Serez-vous présent ?
```

**Buttons (quick reply):** `Confirmer` · `Annuler`

## Arabic (`ar`)

**Body**

```
مرحبًا {{1}}، نذكّرك بموعدك يوم {{2}} الساعة {{3}}. هل ما زلت قادرًا على الحضور؟
```

**Buttons (quick reply):** `تأكيد` · `إلغاء`

## What happens then

- The reminder goes out the chosen number of hours before each booking that has a
  WhatsApp number and is still booked or confirmed — once, even across restarts. A booking
  made after its reminder time (booked at 5pm for 9am the next morning, with 24h reminders)
  gets none: the customer has just talked to you.
- **Confirm** marks the booking confirmed; **Cancel** cancels it and frees the time. The
  customer gets a one-line answer in the template's language. Neither goes to the AI.
- A button tapped by someone other than the booking's customer is ignored.
- Moving a booking sends a fresh reminder for the new time.
- **Pause agent** (Overview) also stops reminders.
- If Meta refuses a send outright (template not approved, wrong name or language), the
  reminder is logged as failed (`reminder_failed`, with Meta's error) and not retried. If
  Meta accepts it but can't deliver it, it shows in the inbox as "Not delivered".
- In the inbox, a reminder appears as an automatic message: `⏰ appointment_reminder: Sam · …`.
