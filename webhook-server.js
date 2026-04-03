require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const DOCTOR_CALCOM_MAP = {
  "dr. sooch":        { username: "arv-sooch",      eventTypeId: 1 },
  "dr. arv sooch":    { username: "arv-sooch",      eventTypeId: 1 },
  "dr. sadeghi":      { username: "ali-sadeghi",    eventTypeId: 2 },
  "dr. potluri":      { username: "ajay-potluri",   eventTypeId: 3 },
  "dr. lau":          { username: "arthur-lau",     eventTypeId: 4 },
  "dr. arthur lau":   { username: "arthur-lau",     eventTypeId: 4 },
  "dr. muise":        { username: "ashlee-muise",   eventTypeId: 5 },
  "dr. howarth":      { username: "ryan-howarth",   eventTypeId: 6 },
  "dr. gill":         { username: "anoop-gill",     eventTypeId: 7 },
  "dr. rowena sooch": { username: "rowena-sooch",   eventTypeId: 8 },
  "dr. noormohammed": { username: "zahra-n",        eventTypeId: 9 },
  "dr. mousavi":      { username: "neda-mousavi",   eventTypeId: 10 },
  "any":              { username: "city-square-dental", eventTypeId: 1 }
};

const SERVICE_DURATION = {
  "cleaning": 30,
  "exam": 30,
  "cleaning and exam": 60,
  "consultation": 30,
  "invisalign consultation": 45,
  "root canal": 90,
  "extraction": 60,
  "implant": 120,
  "crown": 90,
  "filling": 60,
  "whitening": 60,
  "emergency": 30,
  "default": 30
};

// Normalize any phone number to E.164 format
// Handles: Indian (+91), Canadian (+1), raw 10-digit, already formatted
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return raw;           // already E.164
  if (digits.length === 10) return "+1" + digits; // North America, no country code
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits; // 1-xxx format
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits; // India 91xxxxxxxxxx
  if (digits.length === 10 && !raw.startsWith("+")) return "+" + digits;   // fallback: prepend +
  return "+" + digits; // last resort: just prepend +
}

const calApi = axios.create({
  baseURL: "https://api.cal.com/v2",
  headers: {
    Authorization: `Bearer ${process.env.CALCOM_API_KEY}`,
    "cal-api-version": "2024-08-13",
    "Content-Type": "application/json"
  }
});

app.post("/check-availability", async (req, res) => {
  try {
    const { doctorName, serviceType, preferredDate, preferredTime } = req.body;
    const doctorKey = (doctorName || "any").toLowerCase();
    const doctor = DOCTOR_CALCOM_MAP[doctorKey] || DOCTOR_CALCOM_MAP["any"];

    const startDate = preferredDate ? new Date(preferredDate) : new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 5);

    const startISO = startDate.toISOString().split("T")[0];
    const endISO = endDate.toISOString().split("T")[0];

    const response = await calApi.get("/slots/available", {
      params: {
        eventTypeId: doctor.eventTypeId,
        startTime: startISO + "T00:00:00Z",
        endTime: endISO + "T23:59:59Z",
        timeZone: "America/Vancouver"
      }
    });

    const allSlots = response.data?.data?.slots || {};
    let availableSlots = [];

    Object.entries(allSlots).forEach(([date, slots]) => {
      slots.forEach(slot => {
        const slotDate = new Date(slot.time);
        const hour = slotDate.getHours();
        let include = true;
        if (preferredTime === "morning" && hour >= 12) include = false;
        if (preferredTime === "afternoon" && (hour < 12 || hour >= 17)) include = false;
        if (preferredTime === "evening" && hour < 17) include = false;
        if (include) {
          availableSlots.push({
            datetime: slot.time,
            readable: slotDate.toLocaleString("en-CA", {
              weekday: "long", month: "long", day: "numeric",
              hour: "numeric", minute: "2-digit", hour12: true,
              timeZone: "America/Vancouver"
            })
          });
        }
      });
    });

    const topSlots = availableSlots.slice(0, 3);
    if (topSlots.length === 0) {
      return res.json({ success: false, message: "No availability found. Please try a different week.", slots: [] });
    }
    return res.json({ success: true, doctorName: doctorName || "our next available dentist", slots: topSlots });

  } catch (err) {
    console.error("checkAvailability error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Trouble checking the calendar. We will call you back to confirm.", error: err.message });
  }
});

app.post("/create-booking", async (req, res) => {
  try {
    const { patientName, patientPhone, patientEmail, patientDOB, isNewPatient, doctorName, serviceType, appointmentDateTime, notes } = req.body;

    if (!patientName || !appointmentDateTime) {
      return res.status(400).json({ success: false, message: "Missing required fields: patientName and appointmentDateTime are required." });
    }

    const doctorKey = (doctorName || "any").toLowerCase();
    const doctor = DOCTOR_CALCOM_MAP[doctorKey] || DOCTOR_CALCOM_MAP["any"];

    const bookingPayload = {
      eventTypeId: doctor.eventTypeId,
      start: appointmentDateTime,
      attendee: {
        name: patientName,
        email: patientEmail || `noemail_${Date.now()}@placeholder.com`,
        timeZone: "America/Vancouver",
        language: "en"
      },
      metadata: {
        phone: patientPhone || "not provided",
        dob: patientDOB || "",
        isNew: isNewPatient ? "Yes" : "No",
        serviceType: serviceType || "",
        notes: notes || "",
        bookedVia: "Vapi AI Assistant"
      }
    };

    const bookingRes = await calApi.post("/bookings", bookingPayload);
    const bookingData = bookingRes.data?.data;

    if (!bookingData?.uid) throw new Error("Cal.com did not return a booking UID");

    const apptDate = new Date(appointmentDateTime);
    const friendlyDate = apptDate.toLocaleString("en-CA", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "America/Vancouver"
    });

    // Send SMS to patient if phone provided
    const normalizedPatientPhone = normalizePhone(patientPhone);
    if (normalizedPatientPhone) {
      const patientSMS = `Hi ${patientName.split(" ")[0]}! Your appointment at City Square Dental is confirmed.\n\nDate: ${friendlyDate}\nDoctor: ${doctorName}\nService: ${serviceType}\n\nAddress: Unit 5, City Square Mall, 555 W 12th Ave, Vancouver\n\nQuestions? Call 604-876-4537.`;
      try {
        await twilioClient.messages.create({
          body: patientSMS,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: normalizedPatientPhone
        });
        console.log("Patient SMS sent to:", normalizedPatientPhone);
      } catch (smsErr) {
        console.error("Patient SMS failed:", smsErr.message);
        // Don't crash — booking still succeeded
      }
    } else {
      console.warn("No patient phone provided, skipping SMS");
    }

    // Send notification SMS to clinic
    const clinicSMS = `NEW BOOKING - ${doctorName}\nPatient: ${patientName}${isNewPatient ? " (NEW)" : ""}\nService: ${serviceType}\nTime: ${friendlyDate}\nPhone: ${patientPhone || "not provided"}\nNotes: ${notes || "None"}\nRef: ${bookingData.uid}`;
    try {
      await twilioClient.messages.create({
        body: clinicSMS,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.CLINIC_NOTIFICATION_NUMBER
      });
    } catch (smsErr) {
      console.error("Clinic SMS failed:", smsErr.message);
    }

    return res.json({
      success: true,
      bookingId: bookingData.uid,
      message: `Appointment confirmed for ${patientName} on ${friendlyDate}.${normalizedPatientPhone ? " SMS confirmation sent." : ""}`,
      details: { patientName, doctorName, serviceType, dateTime: friendlyDate, bookingRef: bookingData.uid }
    });

  } catch (err) {
    console.error("createBooking error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Could not complete the booking. Our team will call you within 30 minutes.", error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", clinic: "City Square Dental", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));

// .env file needed:
// CALCOM_API_KEY=cal_live_xxxx
// TWILIO_ACCOUNT_SID=ACxxxx
// TWILIO_AUTH_TOKEN=xxxx
// TWILIO_PHONE_NUMBER=+16045550000
// CLINIC_NOTIFICATION_NUMBER=+16045550001
// PORT=3000
