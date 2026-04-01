// ============================================================
// City Square Dental — Vapi Webhook Server
// Handles: availability checks, booking creation, SMS confirmations
// Stack: Node.js + Express + Cal.com API + Twilio SMS
// ============================================================
// 
// SETUP INSTRUCTIONS:
// 1. npm init -y
// 2. npm install express axios twilio dotenv
// 3. Create .env file (see bottom of this file)
// 4. Deploy to Railway / Render / Vercel
// 5. Paste your deployed URL into vapi-assistant-config.json
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(express.json());

// ── Twilio SMS client ──────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Doctor → Cal.com username mapping ─────────────────────
// Each doctor has their own Cal.com account/team member.
// Go to app.cal.com → Settings → Profile to find usernames.
const DOCTOR_CALCOM_MAP = {
  "dr. sooch":       { username: "arv-sooch",      eventTypeId: 1 },
  "dr. arv sooch":   { username: "arv-sooch",      eventTypeId: 1 },
  "dr. sadeghi":     { username: "ali-sadeghi",    eventTypeId: 2 },
  "dr. potluri":     { username: "ajay-potluri",   eventTypeId: 3 },
  "dr. lau":         { username: "arthur-lau",     eventTypeId: 4 },
  "dr. arthur lau":  { username: "arthur-lau",     eventTypeId: 4 },
  "dr. muise":       { username: "ashlee-muise",   eventTypeId: 5 },
  "dr. howarth":     { username: "ryan-howarth",   eventTypeId: 6 },
  "dr. gill":        { username: "anoop-gill",     eventTypeId: 7 },
  "dr. rowena sooch":{ username: "rowena-sooch",   eventTypeId: 8 },
  "dr. noormohammed":{ username: "zahra-n",        eventTypeId: 9 },
  "dr. mousavi":     { username: "neda-mousavi",   eventTypeId: 10 },
  "any":             { username: "city-square-dental", eventTypeId: 1 }
};

// Service type → appointment duration (minutes)
const SERVICE_DURATION = {
  "cleaning":                30,
  "exam":                    30,
  "cleaning and exam":       60,
  "consultation":            30,
  "invisalign consultation": 45,
  "root canal":              90,
  "extraction":              60,
  "implant":                 120,
  "crown":                   90,
  "filling":                 60,
  "whitening":               60,
  "emergency":               30,
  "default":                 30
};

// ── Cal.com API helper ─────────────────────────────────────
const calApi = axios.create({
  baseURL: "https://api.cal.com/v2",
  headers: {
    Authorization: `Bearer ${process.env.CALCOM_API_KEY}`,
    "cal-api-version": "2024-08-13",
    "Content-Type": "application/json"
  }
});

// ── ROUTE 1: Check availability ────────────────────────────
app.post("/check-availability", async (req, res) => {
  try {
    const { doctorName, serviceType, preferredDate, preferredTime } = req.body;

    const doctorKey = (doctorName || "any").toLowerCase();
    const doctor = DOCTOR_CALCOM_MAP[doctorKey] || DOCTOR_CALCOM_MAP["any"];

    // Build date range (default: next 5 business days)
    const startDate = preferredDate
      ? new Date(preferredDate)
      : new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 5);

    const startISO = startDate.toISOString().split("T")[0];
    const endISO   = endDate.toISOString().split("T")[0];

    // Fetch available slots from Cal.com
    const response = await calApi.get("/slots/available", {
      params: {
        eventTypeId: doctor.eventTypeId,
        startTime:   startISO + "T00:00:00Z",
        endTime:     endISO   + "T23:59:59Z",
        timeZone:    "America/Vancouver"
      }
    });

    const allSlots = response.data?.data?.slots || {};
    let availableSlots = [];

    // Flatten slots into readable list
    Object.entries(allSlots).forEach(([date, slots]) => {
      slots.forEach(slot => {
        const slotDate = new Date(slot.time);
        const hour = slotDate.getHours();

        // Filter by preferred time
        let include = true;
        if (preferredTime === "morning"   && hour >= 12) include = false;
        if (preferredTime === "afternoon" && (hour < 12 || hour >= 17)) include = false;
        if (preferredTime === "evening"   && hour < 17) include = false;

        if (include) {
          availableSlots.push({
            datetime: slot.time,
            readable: slotDate.toLocaleString("en-CA", {
              weekday: "long",
              month:   "long",
              day:     "numeric",
              hour:    "numeric",
              minute:  "2-digit",
              hour12:  true,
              timeZone: "America/Vancouver"
            })
          });
        }
      });
    });

    // Return top 3 options for the AI to offer
    const topSlots = availableSlots.slice(0, 3);

    if (topSlots.length === 0) {
      return res.json({
        success: false,
        message: "No availability found in the requested window. Please try a different week.",
        slots: []
      });
    }

    return res.json({
      success: true,
      doctorName: doctorName || "our next available dentist",
      slots: topSlots,
      message: `I found ${topSlots.length} available slots.`
    });

  } catch (err) {
    console.error("checkAvailability error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "I'm having trouble checking the calendar right now. Let me take your details and we'll call you back to confirm.",
      error: err.message
    });
  }
});

// ── ROUTE 2: Create booking ────────────────────────────────
app.post("/create-booking", async (req, res) => {
  try {
    const {
      patientName,
      patientPhone,
      patientEmail,
      patientDOB,
      isNewPatient,
      doctorName,
      serviceType,
      appointmentDateTime,
      notes
    } = req.body;

    const doctorKey = (doctorName || "any").toLowerCase();
    const doctor    = DOCTOR_CALCOM_MAP[doctorKey] || DOCTOR_CALCOM_MAP["any"];
    const duration  = SERVICE_DURATION[serviceType?.toLowerCase()] || SERVICE_DURATION["default"];

    // Create booking in Cal.com
    const bookingPayload = {
      eventTypeId:  doctor.eventTypeId,
      start:        appointmentDateTime,
      attendee: {
        name:     patientName,
        email:    patientEmail || `${patientPhone.replace(/\D/g, "")}@noemail.placeholder`,
        timeZone: "America/Vancouver",
        language: "en"
      },
      metadata: {
        phone:      patientPhone,
        dob:        patientDOB       || "",
        isNew:      isNewPatient     ? "Yes" : "No",
        serviceType: serviceType     || "",
        notes:      notes            || "",
        bookedVia:  "Vapi AI Assistant"
      }
    };

    const bookingRes = await calApi.post("/bookings", bookingPayload);
    const bookingData = bookingRes.data?.data;

    if (!bookingData?.uid) {
      throw new Error("Cal.com did not return a booking UID");
    }

    // Format the confirmed time for SMS
    const apptDate = new Date(appointmentDateTime);
    const friendlyDate = apptDate.toLocaleString("en-CA", {
      weekday: "long",
      month:   "long",
      day:     "numeric",
      year:    "numeric",
      hour:    "numeric",
      minute:  "2-digit",
      hour12:  true,
      timeZone: "America/Vancouver"
    });

    // ── Send SMS to patient ──────────────────────────────
    const patientSMS = `Hi ${patientName.split(" ")[0]}! Your appointment at City Square Dental is confirmed.\n\nDate: ${friendlyDate}\nDoctor: ${doctorName}\nService: ${serviceType}\n\nAddress: Unit 5, City Square Mall, 555 W 12th Ave, Vancouver\n\nReply CANCEL to cancel. Questions? Call 604-876-4537.`;

    await twilioClient.messages.create({
      body: patientSMS,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   patientPhone.startsWith("+") ? patientPhone : "+1" + patientPhone.replace(/\D/g, "")
    });

    // ── Send SMS to doctor/clinic ────────────────────────
    const clinicSMS = `NEW BOOKING — ${doctorName}\nPatient: ${patientName}${isNewPatient ? " (NEW)" : ""}\nService: ${serviceType}\nTime: ${friendlyDate}\nPhone: ${patientPhone}\nNotes: ${notes || "None"}\nBooking ID: ${bookingData.uid}`;

    await twilioClient.messages.create({
      body: clinicSMS,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   process.env.CLINIC_NOTIFICATION_NUMBER
    });

    return res.json({
      success:   true,
      bookingId: bookingData.uid,
      message:   `Appointment confirmed! A confirmation SMS has been sent to ${patientPhone}.`,
      details: {
        patientName,
        doctorName,
        serviceType,
        dateTime: friendlyDate,
        bookingRef: bookingData.uid
      }
    });

  } catch (err) {
    console.error("createBooking error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "I wasn't able to complete the booking in our system, but I've noted your details. Our team will call you within 30 minutes to confirm manually.",
      error: err.message
    });
  }
});

// ── Health check ───────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", clinic: "City Square Dental", timestamp: new Date().toISOString() });
});

// ── Start server ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`City Square Dental webhook server running on port ${PORT}`);
});

// ============================================================
// .env FILE — create this in your project root:
// ============================================================
//
// CALCOM_API_KEY=cal_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// TWILIO_PHONE_NUMBER=+16045550000
// CLINIC_NOTIFICATION_NUMBER=+16045550001
// PORT=3000
//
// ============================================================
// DEPLOYMENT — Railway (easiest, 5 minutes):
// 1. Push this to a GitHub repo
// 2. Go to railway.app → New Project → Deploy from GitHub
// 3. Add environment variables in Railway dashboard
// 4. Copy the generated URL → paste into vapi-assistant-config.json
// ============================================================
