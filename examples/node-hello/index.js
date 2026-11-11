// A plain AWS Lambda handler. Nothing here is Xero-specific.
exports.handler = async (event, context) => {
  const name = (event && event.name) || 'world';
  console.log(JSON.stringify({ msg: 'handling request', requestId: context.awsRequestId }));
  return { message: `Hello, ${name}!`, remainingMs: context.getRemainingTimeInMillis() };
};
