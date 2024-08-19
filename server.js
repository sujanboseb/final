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

// Function to log current database contents
async function logDatabaseContents() {
    try {
        const allDocs = await db.list({ include_docs: true });
        console.log("Current database contents:", JSON.stringify(allDocs.rows, null, 2));
    } catch (error) {
        console.error("Error fetching database contents:", error);
    }
}

app.post("/webhook", async (req, res) => {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

    if (message?.type === "text") {
        try {
            const response = await axios.post('https://52fd-35-247-20-2.ngrok-free.app/predict', { text: message.text.body });
            const intentData = response.data;

            // Log the response from the predict endpoint
            console.log("Response from predict endpoint:", JSON.stringify(intentData, null, 2));

            // Log current database contents
            await logDatabaseContents();

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

                // Log the existing bookings found
                console.log("Existing bookings found:", JSON.stringify(existingBookings.docs, null, 2));

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

                // Log the current database contents after booking
                await logDatabaseContents();

            } else if (intent === "meeting_booking_stats") {
                // Fetch all bookings made by the phone number
                const bookings = await db.find({
                    selector: {
                        "data.employee": phoneNumber,
                        "data.intent": "meeting_booking"
                    }
                });

                // Log the bookings retrieved for the phone number
                console.log("Bookings retrieved for phone number:", JSON.stringify(bookings.docs, null, 2));

                res.json({ bookings: bookings.docs });

                // Log the current database contents after retrieving stats
                await logDatabaseContents();
            }

        } catch (error) {
            console.error("Error processing webhook:", error);
            res.sendStatus(500);
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
