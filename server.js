require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient } = require('mongodb');
const redis = require('redis');
const { promisify } = require('util');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, PORT, WHATSAPP_API_TOKEN } = process.env;

const mongoUri = `mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const dbName = 'sujan';
const collectionName = 'meeting booking';

let dbClient;
let collection;

// Redis setup
const redisClient = redis.createClient({
    url: 'redis://default:DNHJkvKrwo8sOo31u3uBLKI0qfr4zJAx@redis-11656.c305.ap-south-1-1.ec2.redns.redis-cloud.com:11656'
});
redisClient.on('error', (err) => console.error('Redis error:', err));
const getAsync = promisify(redisClient.get).bind(redisClient);
const setAsync = promisify(redisClient.set).bind(redisClient);

// MongoDB connection
async function connectToMongoDB() {
    if (!dbClient) {
        dbClient = new MongoClient(mongoUri);
        try {
            await dbClient.connect();
            console.log("Connected to MongoDB");
            collection = dbClient.db(dbName).collection(collectionName);
        } catch (error) {
            console.error("Error connecting to MongoDB:", error);
            throw error;
        }
    }
    return collection;
}

// Utility functions
function parsePredictResponse(response) {
    if (typeof response === 'string') {
        const result = {};
        const pairs = response.split(',').map(pair => pair.trim());
        pairs.forEach(pair => {
            const [key, value] = pair.split('=').map(part => part.trim());
            if (key && value) {
                result[key] = value;
            }
        });
        return result;
    }
    return {};
}

async function sendMessageToUser(phoneNumber, message) {
    try {
        const response = await axios.post('https://graph.facebook.com/v20.0/375773435616684/messages', {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: message }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
            }
        });
        console.log("Message sent to user:", response.data);
    } catch (error) {
        console.error("Error sending message to user:", error);
    }
}

function parseTime(timeStr) {
    // Extract hours and minutes from timeStr
    const [hours, minutes] = timeStr.split(':').map(part => part.trim());
    if (hours === undefined || minutes === undefined) {
        throw new Error(`Invalid time format: ${timeStr}`);
    }
    return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

async function getMeetingDetails(phoneNumber) {
    const conversationData = await getAsync(phoneNumber);
    return conversationData ? JSON.parse(conversationData) : {};
}

async function saveMeetingDetails(phoneNumber, details) {
    let conversationData = await getMeetingDetails(phoneNumber);
    conversationData = { ...conversationData, ...details };
    await setAsync(phoneNumber, JSON.stringify(conversationData));
}

function validateMeetingDetails(details) {
    const missingFields = [];
    if (!details.meeting_date) missingFields.push("meeting date");
    if (!details.hall_name) missingFields.push("hall name");
    if (!details.no_of_persons) missingFields.push("number of persons");
    if (!details.starting_time) missingFields.push("starting time");
    if (!details.ending_time) missingFields.push("ending time");

    return missingFields;
}

// Webhook to handle incoming messages
app.post("/webhook", async (req, res) => {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

    if (message?.type === "text") {
        const userMessage = message.text.body;
        const phoneNumber = message.from;

        console.log("User message received:", userMessage);

        try {
            const response = await axios.post('https://89e6-34-138-39-113.ngrok-free.app/predict', { text: userMessage });
            console.log("Response from prediction service:", response.data);

            const intentData = parsePredictResponse(response.data);
            console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

            const conversationData = await getMeetingDetails(phoneNumber);
            const combinedData = { ...conversationData, ...intentData };

            const missingFields = validateMeetingDetails(combinedData);

            if (missingFields.length > 0) {
                await saveMeetingDetails(phoneNumber, combinedData);
                await sendMessageToUser(phoneNumber, `The following entries are missing: ${missingFields.join(", ")}. Please provide them.`);
            } else {
                const collection = await connectToMongoDB();
                const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");

                // Validate date and time
                const today = new Date();
                const [day, month, year] = combinedData.meeting_date.split('/').map(num => parseInt(num, 10));
                const meetingDate = new Date(year, month - 1, day);

                if (meetingDate < today) {
                    await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
                    res.sendStatus(200);
                    return;
                }

                // Validate hall capacity
                const hallDetails = await hallDetailsCollection.findOne({ hall_name: combinedData.hall_name });
                if (!hallDetails) {
                    await sendMessageToUser(phoneNumber, `The hall ${combinedData.hall_name} does not exist. Please choose a valid hall.`);
                    res.sendStatus(200);
                    return;
                }

                if (parseInt(combinedData.no_of_persons, 10) > hallDetails.room_capacity) {
                    const availableHalls = await hallDetailsCollection.find({ room_capacity: { $gte: parseInt(combinedData.no_of_persons, 10) } }).toArray();
                    const availableHallNames = availableHalls.map(hall => hall.hall_name).join(", ");

                    if (availableHallNames.length > 0) {
                        await sendMessageToUser(phoneNumber, `The hall ${combinedData.hall_name} cannot accommodate ${combinedData.no_of_persons} people. Available halls that can accommodate your group are: ${availableHallNames}.`);
                    } else {
                        await sendMessageToUser(phoneNumber, `The hall ${combinedData.hall_name} cannot accommodate ${combinedData.no_of_persons} people, and unfortunately, no other halls are available that can accommodate your group size.`);
                    }

                    res.sendStatus(200);
                    return;
                }

                // Ensure times are in hh:mm format
                const formattedStartingTime = parseTime(combinedData.starting_time);
                const formattedEndingTime = parseTime(combinedData.ending_time);

                // Check for existing bookings
                const existingBookings = await collection.find({
                    "data.hall_name": combinedData.hall_name,
                    "data.meeting_date": combinedData.meeting_date,
                    "$or": [
                        {
                            "data.starting_time": { "$lte": formattedEndingTime },
                            "data.ending_time": { "$gte": formattedStartingTime }
                        }
                    ]
                }).toArray();

                if (existingBookings.length > 0) {
                    await sendMessageToUser(phoneNumber, `Another meeting has been booked during this time in the ${combinedData.hall_name}.`);
                    res.sendStatus(200);
                    return;
                }

                // Finalize the booking
                const meetingId = `meetingbooking:${new Date().getTime()}`;
                const bookingData = {
                    _id: meetingId,
                    data: {
                        meeting_date: combinedData.meeting_date,
                        intent: combinedData.intent,
                        hall_name: combinedData.hall_name,
                        no_of_persons: combinedData.no_of_persons,
                        starting_time: formattedStartingTime,
                        ending_time: formattedEndingTime,
                        employee: phoneNumber
                    }
                };

                await collection.insertOne(bookingData);
                const successMessage = `Meeting has been booked successfully with Meeting ID: ${meetingId}`;
                await sendMessageToUser(phoneNumber, successMessage);

                // Clear the state after successful booking
                redisClient.del(phoneNumber);

                res.json({ success: successMessage });
            }

        } catch (error) {
            console.error("Error handling the message:", error);
            await sendMessageToUser(phoneNumber, "There was an error processing your request. Please try again later.");
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(400);
    }
});

app.get("/webhook", (req, res) => {
    const mode = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = req.query['hub.verify_token'];

    if (mode === "subscribe" && verifyToken === WEBHOOK_VERIFY_TOKEN) {
        console.log("Webhook verification successful.");
        res.status(200).send(challenge);
    } else {
        console.error("Webhook verification failed.");
        res.sendStatus(403);
    }
});


// Start the server
const port = PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
