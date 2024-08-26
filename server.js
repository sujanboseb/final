require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require('mongodb');
const moment = require('moment');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, PORT, WHATSAPP_API_TOKEN } = process.env;

const mongoUri = `mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const dbName = 'sujan';
const collectionName = 'meeting booking';

let dbClient;
let collection;

async function connectToMongoDB() {
  if (!dbClient) {
    dbClient = new MongoClient(mongoUri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      }
    });

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

async function generateMeetingId(collection) {
  let lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  let lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  let newId;
  let isDuplicate;

  do {
    newId = `meetingbooking:${lastId + 1}`;
    isDuplicate = await collection.findOne({ _id: newId });
    lastId++; // Increment to avoid reusing the same ID
  } while (isDuplicate);

  return newId;
}

async function generateCabBookingId(collection) {
    let lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
    let lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
    let newId;
    let isDuplicate;

    do {
        newId = `cabbooking:${lastId + 1}`;
        isDuplicate = await collection.findOne({ _id: newId });
        lastId++; // Increment to avoid reusing the same ID
    } while (isDuplicate);

    return newId;
}


function parsePredictResponse(response) {
  if (typeof response === 'string') {
    const result = {};
    const pairs = response.split(',').map(pair => pair.trim());
    pairs.forEach(pair => {
      const [key, value] = pair.split(':').map(part => part.trim());
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

function isGreeting(message) {
  const greetings = ["hi", "hello", "namaskaram"];
  const words = message.toLowerCase().split(/\W+/);
  return greetings.some(greeting => words.includes(greeting)) && message.length < 5;
}

function isInvalidMessage(message) {
  const stopWords = ["a", "an", "the", "and", "but", "or", "stop", "xxx"];
  const words = message.toLowerCase().split(/\W+/);
  return words.some(word => stopWords.includes(word)) && message.length < 5;
}

function convertToAmPm(time) {
  return moment(time, "HH:mm").format("hh:mm A");
}

app.post("/webhook", async (req, res) => {
  try {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message?.type === "text") {
      const userMessage = message.text.body;
      const phoneNumber = message.from;

      if (!phoneNumber) {
        console.error("Phone number is not defined.");
        res.sendStatus(400);
        return;
      }

      console.log("User message received:", userMessage);

      if (isGreeting(userMessage)) {
        await sendMessageToUser(phoneNumber, "Hi, welcome to cab and hall management system");
        res.sendStatus(200);
        return;
      }

      if (isInvalidMessage(userMessage)) {
        await sendMessageToUser(phoneNumber, "You are entering stopwords and all; please enter relevant messages.");
        res.sendStatus(200);
        return;
      }

      try {
        // Call the prediction service
        const response = await axios.post('https://d6e3-34-85-175-167.ngrok-free.app/predict', { text: userMessage });
        console.log("Response from prediction service:", response.data);

        const intentData = parsePredictResponse(response.data);

        // Log the parsed intent data
        console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

        const collection = await connectToMongoDB();
        const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
        const cabBookingCollection = dbClient.db(dbName).collection("cab_booking");
        const intent = intentData.intent;

        if (!intent) {
          await sendMessageToUser(phoneNumber, "Intent not recognized in prediction response.");
          res.sendStatus(200);
          return;
        }

        if (intent === "meeting_booking") {
          const { meeting_date, hall_name, no_of_persons, starting_time, ending_time, ...extraEntities } = intentData;

          const expectedEntities = ["meeting_date", "hall_name", "no_of_persons", "starting_time", "ending_time"];
          const providedEntities = Object.keys(intentData);

          // Check for extra entities
          const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

          if (extraEntitiesDetected.length > 0) {
            await sendMessageToUser(phoneNumber, "I can't book the meeting as you provided irrelevant information.");
            res.sendStatus(200);
            return;
          }

          if (!meeting_date || !hall_name || !no_of_persons || !starting_time || !ending_time) {
            const missingFields = [];
            if (!meeting_date) missingFields.push("meeting date");
            if (!hall_name) missingFields.push("hall name");
            if (!no_of_persons) missingFields.push("number of persons");
            if (!starting_time) missingFields.push("starting time");
            if (!ending_time) missingFields.push("ending time");

            const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
            await sendMessageToUser(phoneNumber, missingMessage);
            res.sendStatus(200);
            return;
          }

          // Compare meeting date with today's date
          const today = new Date();
          const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
          const meetingDate = new Date(year, month - 1, day); // Adjusting the date format

          if (meetingDate < today) {
            await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
            res.sendStatus(200);
            return;
          }

          // Check hall capacity
          const hallDetails = await hallDetailsCollection.findOne({ hall_name: hall_name });
          if (!hallDetails) {
            await sendMessageToUser(phoneNumber, `The hall ${hall_name} does not exist. Please choose a valid hall.`);
            res.sendStatus(200);
            return;
          }

          if (parseInt(no_of_persons, 10) > hallDetails.room_capacity) {
            // Find all halls that can accommodate the number of persons
            const availableHalls = await hallDetailsCollection.find({ room_capacity: { $gte: parseInt(no_of_persons, 10) } }).toArray();
            const availableHallNames = availableHalls.map(hall => hall.hall_name).join(", ");

            if (availableHallNames.length > 0) {
              await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people. Available halls that can accommodate your group are: ${availableHallNames}.`);
            } else {
              await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people, and unfortunately, no other halls are available that can accommodate your group size.`);
            }

            res.sendStatus(200);
            return;
          }

          const formattedStartingTime = convertToAmPm(starting_time);
          const formattedEndingTime = convertToAmPm(ending_time);

          // Check for existing bookings
          const existingBookings = await collection.find({
            "data.hall_name": hall_name,
            "data.meeting_date": meeting_date,
            "$or": [
              {
                "data.starting_time": { "$lte": formattedEndingTime },
                "data.ending_time": { "$gte": formattedStartingTime }
              }
            ]
          }).toArray();

          if (existingBookings.length > 0) {
            await sendMessageToUser(phoneNumber, `Another meeting has been booked during this time in the ${hall_name}.`);
            res.json({ error: "Another meeting has been booked during this time in the same hall." });
            return;
          }

          const meetingId = await generateMeetingId(collection);

          const bookingData = {
            _id: meetingId,
            data: {
              meeting_date,
              intent,
              hall_name,
              no_of_persons,
              starting_time: formattedStartingTime,
              ending_time: formattedEndingTime,
              employee: phoneNumber
            }
          };

          await collection.insertOne(bookingData);
          const successMessage = `Meeting has been booked successfully with Meeting ID: ${meetingId}`;
          await sendMessageToUser(phoneNumber, successMessage);
          res.json({ success: successMessage });
          return;

        } else if (intent === "meeting_cancelling") {
          const meetingIdMatch = userMessage.match(/meetingbooking:(\d+)/);

          if (!meetingIdMatch) {
            await sendMessageToUser(phoneNumber, "Please provide a valid meeting ID in the format 'meetingbooking:X' where X is the meeting number.");
            res.sendStatus(200);
            return;
          }

          const meetingId = meetingIdMatch[1];

          // Check if the meeting ID exists
          const meeting = await collection.findOne({ _id: meetingId });

          if (!meeting) {
            await sendMessageToUser(phoneNumber, "You have entered the wrong meeting ID.");
            res.sendStatus(200);
            return;
          }

          // Delete the meeting
          await collection.deleteOne({ _id: meetingId });
          await sendMessageToUser(phoneNumber, "Meeting has been successfully removed.");
          res.sendStatus(200);
          return;

        } else if (intent === "hall_availability") {
          const { hall_name, meeting_date, starting_time, ending_time } = intentData;

          // Check for required entities and ensure no extra entities
          const expectedEntities = ["hall_name", "meeting_date", "starting_time", "ending_time"];
          const providedEntities = Object.keys(intentData);

          // Check if all required entities are present
          const missingFields = expectedEntities.filter(entity => !providedEntities.includes(entity));
          if (missingFields.length > 0) {
            const missingMessage = `Please provide the following missing information: ${missingFields.join(", ")}.`;
            await sendMessageToUser(phoneNumber, missingMessage);
            res.sendStatus(200);
            return;
          }

          // Check for extra entities
          const extraEntities = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');
          if (extraEntities.length > 0) {
            await sendMessageToUser(phoneNumber, "Please enter only the required entities: hall_name, meeting_date, starting_time, and ending_time.");
            res.sendStatus(200);
            return;
          }

          // Format times to AM/PM format if necessary
          const formattedStartingTime = convertToAmPm(starting_time);
          const formattedEndingTime = convertToAmPm(ending_time);

          // Check for existing bookings
          const existingBookings = await collection.find({
            "data.hall_name": hall_name,
            "data.meeting_date": meeting_date,
            "$or": [
              {
                "data.starting_time": { "$lte": formattedEndingTime },
                "data.ending_time": { "$gte": formattedStartingTime }
              }
            ]
          }).toArray();

          if (existingBookings.length > 0) {
            await sendMessageToUser(phoneNumber, "Sorry, during that time a meeting has already been booked in the hall.");
          } else {
            await sendMessageToUser(phoneNumber, "During that time, the hall is free.");
          }

          res.sendStatus(200);
          return;

        } else if (intent === "cab_booking") {
          const { meeting_date, batch_no, cab_name, ...extraEntities } = intentData;

          const expectedEntities = ["meeting_date", "batch_no", "cab_name"];
          const providedEntities = Object.keys(intentData);

          // Check for extra entities
          const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

          if (extraEntitiesDetected.length > 0) {
            await sendMessageToUser(phoneNumber, "I can't book the cab as you provided irrelevant information.");
            res.sendStatus(200);
            return;
          }

          if (!meeting_date || !batch_no || !cab_name) {
            const missingFields = [];
            if (!meeting_date) missingFields.push("meeting_date");
            if (!batch_no) missingFields.push("batch number");
            if (!cab_name) missingFields.push("cab name");

            const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
            await sendMessageToUser(phoneNumber, missingMessage);
            res.sendStatus(200);
            return;
          }

          // Compare booking date with today's date
          const today = new Date();
          const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
          const meetingDate = new Date(year, month - 1, day); // Adjusting the date format

          if (meetingDate < today) {
            await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
            res.sendStatus(200);
            return;
          }

          // Generate cab ID
          const cabId = await generateCabId(cabBookingCollection);

          const bookingData = {
            _id: cabId,
            data: {
              meeting_date,
              batch_no,
              cab_name,
              employee: phoneNumber
            }
          };

          await cabBookingCollection.insertOne(bookingData);
          const successMessage = `Cab has been booked successfully with Booking ID: ${cabId}`;
          await sendMessageToUser(phoneNumber, successMessage);
          res.json({ success: successMessage });
          return;

        } else if (intent === "cab_cancelling") {
          const cabIdMatch = userMessage.match(/cabbooking:(\d+)/);

          if (!cabIdMatch) {
            await sendMessageToUser(phoneNumber, "Please provide a valid cab booking ID in the format 'cabbooking:X' where X is the cab number.");
            res.sendStatus(200);
            return;
          }

          const cabId = cabIdMatch[1];

          // Check if the cab booking ID exists
          const cabBooking = await cabBookingCollection.findOne({ _id: cabId });

          if (!cabBooking) {
            await sendMessageToUser(phoneNumber, `No cab booking found with ID: ${cabId}.`);
            res.sendStatus(200);
            return;
          }

          // Delete the cab booking
          await cabBookingCollection.deleteOne({ _id: cabId });
          await sendMessageToUser(phoneNumber, "Cab booking has been successfully cancelled.");
          res.sendStatus(200);
          return;

        } else if (intent === "meeting_booking_stats") {
          // Handle meeting booking stats
          const bookings = await collection.find({ "data.employee": phoneNumber }).toArray();

          if (bookings.length === 0) {
            await sendMessageToUser(phoneNumber, "You have no upcoming meetings.");
          } else {
            const meetingDetails = bookings.map(booking => {
              const { meeting_date, hall_name, no_of_persons, starting_time, ending_time } = booking.data;
              return `Meeting on ${meeting_date} at ${hall_name}, starting at ${starting_time} and ending at ${ending_time} for ${no_of_persons} persons.`;
            }).join("\n\n");

            const summaryMessage = `Here are your upcoming meetings:\n\n${meetingDetails}`;
            await sendMessageToUser(phoneNumber, summaryMessage);
          }
          res.sendStatus(200);
          return;

        } else {
          await sendMessageToUser(phoneNumber, "Sorry, I didn't understand your request.");
          res.sendStatus(200);
          return;
        }

      } catch (predictionError) {
        console.error("Prediction service error:", predictionError);
        await sendMessageToUser(phoneNumber, "There was an error processing your request. Please try again later.");
        res.sendStatus(500);
        return;
      }
    } else {
      await sendMessageToUser(phoneNumber, "Unsupported message type.");
      res.sendStatus(400);
    }

  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
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
  res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
