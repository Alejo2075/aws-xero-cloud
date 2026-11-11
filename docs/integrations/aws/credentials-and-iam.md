# Credentials and IAM
Three separate identities:
1. **Controller discovery/invoke/poll identity** — the profile in `xero aws connect`. Minimal policies below.
2. **Worker identity** — optional `awsRoleArn` per local deployment, assumed with `sts:AssumeRole`; credentials injected as
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (+`AWS_REGION`). Refreshed by recycling the worker
   before expiry (default session 1 h, refresh margin 5 min). Never persisted, never logged.
3. **Future deployment identity** — not in v0.1.

Trust policy for a worker role (principal = the controller identity):
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<account>:user-or-role/<controller-identity>" },
  "Action": "sts:AssumeRole" }] }
```
Controller identity permissions (grant only the ones for features you use):
```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "Verify",  "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*" },
  { "Sid": "Assume",  "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::<account>:role/xero-*" },
  { "Sid": "Discover","Effect": "Allow", "Action": "lambda:GetFunctionConfiguration", "Resource": "arn:aws:lambda:<region>:<account>:function:<name>*" },
  { "Sid": "Invoke",  "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "arn:aws:lambda:<region>:<account>:function:<name>*" },
  { "Sid": "Poll",    "Effect": "Allow", "Action": ["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:ChangeMessageVisibility","sqs:GetQueueAttributes"], "Resource": "arn:aws:sqs:<region>:<account>:<queue>" } ] }
```
Production on-prem: prefer IAM Roles Anywhere or OIDC federation over profiles with static keys. Never put keys in artifacts.
