// The same handler code can back a native Lambda and a Xero local worker.
// The AWS SDK v3 ships inside the AWS Lambda Node.js base images, so no bundling is needed.
// Credentials are never in this file: the SDK resolves them per environment (Lambda execution role on AWS;
// short-lived credentials of the role named in xero.yaml on a Xero worker).
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});

async function processOne(id) {
  const result = await dynamodb.send(new GetItemCommand({ TableName: process.env.TABLE_NAME, Key: { id: { S: id } } }));
  return { id, found: Boolean(result.Item) };
}

exports.handler = async (event) => {
  // SQS-triggered (native Lambda or the Xero SQS adapter): partial batch response, idempotent per message.
  if (event && Array.isArray(event.Records)) {
    const batchItemFailures = [];
    for (const record of event.Records) {
      try {
        await processOne(JSON.parse(record.body).id);
      } catch (err) {
        console.error(JSON.stringify({ msg: 'record failed', messageId: record.messageId, error: err.name }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }
  // Direct invocation (xero invoke / Lambda Invoke): { "id": "order-1" }
  return processOne(event.id);
};
