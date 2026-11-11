# Local handlers calling AWS services
Use the normal SDK with default credential resolution (`new DynamoDBClient({})`). When the deployment has `awsRoleArn`,
Xero sets env credentials for that worker. Xero does not proxy or emulate AWS services. Access is limited by the
role's IAM policy and container networking. See `examples/hybrid-process-order`.
