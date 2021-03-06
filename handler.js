'use strict';

const fs = require('fs');
const mime = require('mime-types');
const webPush = require('web-push');
const aws = require("aws-sdk");
const sts = new aws.STS();
const s3 = new aws.S3();

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.log("You must set the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY " +
    "environment variables. You can use the following ones:");
  console.log(webPush.generateVAPIDKeys());
}

webPush.setVapidDetails(
  process.env.DOMAIN,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function response(statusCode, body, file) {
  let payload = {
    statusCode,
    body: typeof (body) === 'string' ? body : JSON.stringify(body, null, 2)
  };
  if (file) {
    payload.headers = { 'content-type': mime.contentType(file) };
  }
  console.log('RESPOND', payload);
  return payload;
}

module.exports.vapidPublicKey = async () => {
  return response(200, process.env.VAPID_PUBLIC_KEY);
};

module.exports.register = async (event, context) => {
  // Save the registered users subscriptions (event.body)
  await addSubscription(JSON.parse(event.body));
  return response(201, event);
};

async function getSubscriptions() {
  const s = await s3.getObject({ Bucket: process.env.STATE_BUCKET, Key: 'subscriptions'}).promise();
  return JSON.parse(s.Body.toString("utf-8"));
}

async function addSubscription(subscription) {
  let subscriptions = await getSubscriptions();
  console.log(subscriptions);
  let uniq = {};
  for(let i=0; i<subscriptions.length; i++){
    uniq[subscriptions[i].endpoint] = subscriptions[i];
  }
  uniq[subscription.endpoint] = subscription; // use latest for endpoint
  await s3.putObject({
    Bucket: process.env.STATE_BUCKET,
    Key: 'subscriptions',
    Body: JSON.stringify(Object.values(uniq)),
    ContentType: 'application/json'
  }).promise();
}

// TODO remove stale subscriptions 

function send(subscriptions, payload, options, delay) {
  console.log('send', subscriptions, payload, options, delay);
  const payload_string = typeof (payload) === 'string' ? payload : JSON.stringify(payload)

  return new Promise((success) => {
    setTimeout(() => {

      Promise.all(subscriptions.map((each_subscription) => {
        return webPush.sendNotification(each_subscription, payload_string, options);
      }))
        .then(function () {
          success(response(201, {}));
        }).catch(function (error) {
          console.log('ERROR>', error);
          success(response(500, { error: error }));
        });

    }, 1000 * parseInt(delay));
  });
}

module.exports.sendNotification = async (event) => {
  console.log('register event', JSON.stringify(event, null, 2));
  let body = JSON.parse(event.body);
  const subscription = body.subscription;
  const payload = body.payload;
  const delay = body.delay;
  const options = {
    TTL: body.ttl | 5
  };

  return await send([subscription], payload, options, delay);
};

module.exports.registerOrSendToAll = async (event) => {
  if (event.resource === '/register') {
    await addSubscription(JSON.parse(event.body).subscription);
    return response(201, event);
  } else {
    console.log('register event', JSON.stringify(event, null, 2));
    let body = JSON.parse(event.body);
    console.log('got body', body);
    const payload = body.payload;
    const delay = body.delay;
    const options = {
      TTL: body.ttl | 5
    };
    const subscriptions = await getSubscriptions();
    return await send(subscriptions, payload, options, delay);
  }

};

module.exports.notifyNewOrChanged = async (event) => {
  //console.log('Received event:', JSON.stringify(event));
  let message = null;
  for (let i = 0; i < event.Records.length; i++) {
    const r = event.Records[i];
    switch (r.EventSource) {
      case 'aws:sns':
        message = JSON.parse(r.Sns.Message);
        if (message.hasOwnProperty("Records")) {
          const r = message.Records[0];
          if(r.s3.object.key.startsWith('schedule')) {
            console.log(r.s3.object.key);
          }
          else {
            await handle_appw(r);
          }
        }
        else {
          console.log('unrecognised SNS message',message);
        }
        break;
      default:
      	console.log('Received unknown event:', JSON.stringify(r));
    }
  }
  return `Successfully processed ${event.Records.length} messages.`;
};

async function handle_appw(message) {
  //console.log('handle_appw', JSON.stringify(message));
  const path = message.s3.object.key.split("/");
  let pid = null;
  let entity_type = null;
  let doc = null;
  if(message.s3.bucket.name==='ws-partners-appw-merge-test') {
    entity_type = path[1];
    pid = path[2].split('.')[1];
    const r = await s3.getObject({ Bucket: message.s3.bucket.name, Key: message.s3.object.key }).promise();
    doc = JSON.parse(r.Body.toString("utf-8"));
  }
  else {
    entity_type = path[4];
    pid = path[5].split('.')[1];
    doc = await get_appw(message.s3.bucket.name, message.s3.object.key);
  }
  switch (entity_type) {
    case 'clip':
    case 'episode':
      {
        const entity = doc.pips[entity_type];
        //console.log(JSON.stringify(entity));
        if(entity.hasOwnProperty('languages')) {
          const lang = entity.languages.language[0].$;
          if(lang===process.env.LANG) {
            const payload = {
              msg: `new or changed ${entity_type} ${pid}`,
              pid: pid,
              entity_type: entity_type,
              entity: entity
            };
            console.log(`new or changed ${entity_type} ${pid}`);
            const subscriptions = await getSubscriptions();
            await send(subscriptions, payload, { TTL: 5 }, 0);
          }
        }
      }
      break;
      
    case 'availability':      // safe to ignore, but should we even be getting them here?
    case 'brand':
    case 'series':
      break;
      
    default:
      console.log(JSON.stringify(doc));
  }
}

async function get_appw(bucket, key) {
  console.log('get_appw', bucket, key);
  const appw = await sts
    .assumeRole({
      RoleArn: process.env.APPW_ROLE,
      RoleSessionName: "dazzler-test"
    })
    .promise();

  const appwS3 = new aws.S3({
    accessKeyId: appw.Credentials.AccessKeyId,
    secretAccessKey: appw.Credentials.SecretAccessKey,
    sessionToken: appw.Credentials.SessionToken
  });
  try {
    const appw_doc = await appwS3
      .getObject({ Bucket: bucket, Key: key })
      .promise();
    return JSON.parse(appw_doc.Body.toString("utf-8"));
  }
  catch(error) {
    return null;
  }
}

module.exports.statics = async (event) => {
  // Serve static files from lambda (only for simplicity of this example)
  var file = fs.readFileSync(`./static${event.resource}`);
  return await response(200, file.toString(), event.resource.split('/')[1]);
};
