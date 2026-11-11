# Function specification (`xero.dev/v1alpha1`, not frozen)

A function directory may contain `xero.yaml` (or `xero.json`):

```yaml
apiVersion: xero.dev/v1alpha1
kind: Function
metadata: { name: process-order }
spec:
  runtime: nodejs22.x          # nodejs20.x | nodejs22.x | python3.12 | python3.13
  handler: index.handler       # node: <file>.<export>; python: <module>.<function>
  deployments:
    local:
      artifact: .              # directory relative to the manifest
      memoryMb: 256            # 128..3008 (default 128)
      timeoutSec: 10           # 1..900 (default 3)
      maxConcurrency: 2        # >=1 (default 2)
      idleTtlSec: 60           # default 60
      environment: { TABLE_NAME: orders }
      awsRoleArn: arn:aws:iam::123456789012:role/xero-process-order   # optional, existing role
    aws-lambda:
      mode: existing           # only mode in v0.1
      arn: arn:aws:lambda:us-east-1:123456789012:function:process-order:live
  routing: { strategy: manual, defaultTarget: local }
```
CLI flags override the manifest. Names: `^[a-zA-Z0-9-_]{1,64}$`. Environment keys may not start with `AWS_`
(reserved) or `XERO_`. Payloads are JSON; max request 6 MiB (sync) matching Lambda.
