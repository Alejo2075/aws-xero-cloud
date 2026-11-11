import json


def lambda_handler(event, context):
    name = (event or {}).get("name", "world")
    print(json.dumps({"msg": "handling request", "requestId": context.aws_request_id}))
    return {"message": f"Hello, {name}!", "remainingMs": context.get_remaining_time_in_millis()}
