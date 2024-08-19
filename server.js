require('dotenv').config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const nano = require("nano");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, GRAPH_API_TOKEN, PORT } = process.env;

const url = 'https://192.168.57.185:5984';
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

const opts = {
    url: url,
    requestDefaults: {
        agent: httpsAgent,
        auth: {
            username: 'd_couchdb',
            password: 'Welcome#2'
        }
    }
};

// Initialize CouchDB connection
const couch = nano(opts);
const db = couch.use('sujan');

app.post("/webhook", async (req, res) => {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

    if (message?.type === "text") {
        const response = await axios.post('hhttps://3221-34-124-199-150.ngrok-free.app', { text: message.text.body });
        const intentData = response.data;

        const intent = intentData.intent;
        const phoneNumber = message.from;

        if (intent === "meeting_booking") {
            const { date, hall_name, no_of_persons, starting_time, ending_time, reason } = intentData;

            // Check for existing booking conflicts
            const existingBookings = await db.find({
                selector: {
                    "data.hall_name": hall_name,
                    "data.date": date,
                    "$or": [
                        {
                            "data.strating_time": { "$lte": ending_time },
                            "data.ending_time": { "$gte": starting_time }
                        }
                    ]
                }
            });

            if (existingBookings.docs.length > 0) {
                res.json({ error: "Another meeting has been booked during this time in the same hall." });
                return;
            }

            // Generate a unique meeting ID
            const existingDocs = await db.list({ include_docs: true });
            const meetingCount = existingDocs.rows.length + 1;
            const meetingId = `meetingbooking:${meetingCount}`;

            // Store the booking
            const bookingData = {
                _id: meetingId,
                data: {
                    date,
                    intent,
                    hall_name,
                    no_of_persons,
                    strating_time: starting_time,
                    ending_time,
                    employee: phoneNumber,
                    booking_reason: reason
                }
            };

            await db.insert(bookingData);
            res.json({ success: `Meeting booked successfully with ID: ${meetingId}` });

        } else if (intent === "meeting_booking_stats") {
            // Fetch all bookings made by the phone number
            const bookings = await db.find({
                selector: {
                    "data.employee": phoneNumber,
                    "data.intent": "meeting_booking"
                }
            });

            res.json({ bookings: bookings.docs });
        }
    }

    res.sendStatus(200);
});

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
        console.log("Webhook verified successfully!");
    } else {
        res.sendStatus(403);
    }
});

app.get("/", (req, res) => {
    res.send(`<pre>Nothing to see here.
Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
    console.log(`Server is listening on port: ${PORT}`);
});
