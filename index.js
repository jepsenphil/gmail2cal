const fs = require('fs');
const { DateTime } = require('luxon');
const readline = require('readline');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { parse } = require('node-html-parser');
const cron = require('node-cron');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.WEB_SERVICE_PORT || 3000;

app.use(bodyParser.json());

const jsonCredentials = process.env.CREDENTIALS;
let credentials = {};

if (!jsonCredentials) {
  console.error('CREDENTIALS environment variable is not set.');
  process.exit(1);
}

try {
  credentials = JSON.parse(jsonCredentials);
  console.log('Parsed JSON credentials:', credentials);
} catch (error) {
  console.error('Error parsing JSON credentials:', error.message);
  process.exit(1);
}


const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

// If modifying these SCOPES, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar'];

// The file token.json stores the user's access and refresh tokens, and is created automatically when the authorization flow completes for the first time.
const TOKEN_PATH = process.env.REFRESH_TOKEN_PATH || '/app/tokens/token.json';

authorize(credentials, fetchEmails);

// Load the client secrets
cron.schedule('* * * * *', () => {
  console.log('-> fetching emails', new Date());
  authorize(credentials, fetchEmails);
});

function authorize(credentials, callback) {
  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) {
      console.error('Token not found, attempting to generate!');
      return getNewToken(oAuth2Client, callback);
    }
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('Token', tokens);
    oAuth2Client.setCredentials(tokens);
    // Store the token to disk for later program executions
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.json({ 'auth': true });
    fetchEmails(oAuth2Client);
  } catch (error) {
    console.error('Error getting OAuth tokens:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
}

function findElementByText(root, text) {
  // Recursive function to traverse the DOM tree
  function traverse(node) {
    // Check if the current node has text content
    if (node.text && node.text.trim() === text) {
      return node;
    }

    // Iterate through child nodes
    for (const childNode of node.childNodes) {
      const result = traverse(childNode);
      if (result) {
        return result;
      }
    }

    return null;
  }

  // Start traversing from the root
  return traverse(root);
}

function convertDateString(dateString, hour, minute) {
  console.log('Date in:', dateString)
  const parsedDate = DateTime.fromFormat(dateString, 'EEEE, MMMM d');
  const t = DateTime.utc(parsedDate.year, parsedDate.month, parsedDate.day, hour, minute);
  return t.toString().replace('Z', '');
}

function parseHtml(html) {
  const root = parse(html);
  let recipesList = [];
  let startDate = new Date();
  let endDate = new Date();
  // Extract Delivery Date
  const deliveryDateElement = root.querySelector('strong:contains("Delivery Date:")');
  if (deliveryDateElement) {
    const deliveryDate = deliveryDateElement.nextSibling.rawText.trim();
    startDate = convertDateString(deliveryDate, 17, 0);
    endDate = convertDateString(deliveryDate, 18, 0);
  }

  // Find the element with the text "Recipes:"
  const recipesElement = findElementByText(root, 'Recipes:');
  if (recipesElement) {
    // Extract the list of recipes
    recipesList = recipesElement.nextElementSibling.querySelectorAll('li').map(li => li.text.trim());
  }

  const options = {};

  if (recipesList.length) {
    const out = {
      "summary": `FreshPrep Order - ${recipesList.join(", ")}`,
      "body": recipesList.join(", "),
      "startDateTime": startDate,
      "endDateTime": endDate
    };
    console.log(out)
    return out;
  } else {
    return null;
  }
}

function fetchEmails(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const month = (currentDate.getMonth() + 1).toString().padStart(2, '0'); // Months are zero-based
  const day = new Date(currentDate.setDate(currentDate.getDate() - 2)).getDate().toString().padStart(2, '0');
  const formattedDateString = `${year}/${month}/${day}`;
  // Use Gmail API to fetch emails (add your own query parameters)
  const query = `from:hello@freshprep.ca after:${formattedDateString}`; // Replace yyyy/mm/dd with your desired date range
  console.log('Using query:', query);

  gmail.users.messages.list({
    userId: 'me',
    q: query,
  }, (err, res) => {
    if (err) return console.error('The API returned an error:', err);
    const emails = res.data.messages;
    if (emails && emails.length) {
      // Process each email and create a calendar event (add your own logic)
      emails.forEach((email) => {
        const messageId = email.id;
        gmail.users.messages.get({
          userId: 'me',
          id: messageId,
        }, (err, res) => {
          if (err) return console.error('Error fetching email:', err);
          const emailData = res.data;
          const sender = emailData.payload.headers.find(header => header.name === 'From').value;
          const subject = emailData.payload.headers.find(header => header.name === 'Subject').value;

          if (emailData.payload.body && emailData.payload.body.data) {
            const body = Buffer.from(emailData.payload.body?.data, 'base64').toString('utf-8');
            const event = parseHtml(body);
            if (event) {
              insertCalEntry(auth, event.summary, event.body, event.startDateTime, event.endDateTime);
            }
          }
        });
      });
    } else {
      console.log('No emails found.');
    }
  });
}

function insertCalEntry(auth, summary, body, startDateTime, endDateTime) {
  const calendarId = 'primary';
  const calendar = google.calendar({ version: 'v3', auth });
  const eventDetails = {
    summary: summary,
    description: body,
    start: {
      dateTime: startDateTime, //'2023-01-01T10:00:00',
      timeZone: 'America/Vancouver',
    },
    end: {
      dateTime: endDateTime, ///'2023-01-01T12:00:00',
      timeZone: 'America/Vancouver',
    },
  };

  // Check if the event already exists
  calendar.events.list({
    auth: auth,
    calendarId: calendarId,
    q: summary,
    timeMin: (new Date()).toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime'
  }, (err, res) => {
    if (err) {
      console.error('Error checking existing events:', err.message);
      return;
    }

    const existingEvents = res.data.items;
    console.log('Existing', existingEvents);

    if (existingEvents && existingEvents.length > 0) {
      for (let i = 0; i < existingEvents.length; ++i) {
        const existingEvent = existingEvents[i];
        const eventStartDate = existingEvent.start.dateTime;
        // Remove the timezone offset
        const dateWithoutTimezone = eventStartDate.replace(/([-+]\d{2}:\d{2})$/, '');
        const date1 = DateTime.fromISO(dateWithoutTimezone, { zone: 'UTC' });
        const date2 = DateTime.fromISO(startDateTime, { zone: 'UTC' });
        // Check if the dates are equal
        if (date1.equals(date2)) {
          apiUpdateCalEntry(auth, calendarId, existingEvent.id, eventDetails);
        } else {
          apiInsertCalEntry(auth, calendarId, eventDetails);
        }
      }
    } else {
      apiInsertCalEntry(auth, calendarId, eventDetails);
    }
  });
}

function apiInsertCalEntry(auth, calendarId, eventDetails) {
  const calendar = google.calendar({ version: 'v3', auth });
  calendar.events.insert({
    calendarId: calendarId,
    resource: eventDetails,
  }, (err, res) => {
    if (err) {
      console.error('Error inserting new event:', err.message);
    } else {
      console.log('Event inserted:', res.data);
    }
  });
}

function apiUpdateCalEntry(auth, calendarId, existingEventId, eventDetails) {
  const calendar = google.calendar({ version: 'v3', auth });
  calendar.events.update({
    calendarId: calendarId,
    eventId: existingEventId,
    resource: eventDetails,
  }, (err, res) => {
    if (err) {
      console.error('Error updating existing event:', err.message);
    } else {
      console.log('Event updated:', res.data);
    }
  });
}


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
