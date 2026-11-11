import os


def handler(event, context):
    if event.get("log"):
        print(event["log"])
    if event.get("raise"):
        raise ValueError("intentional failure")
    return {"ok": True, "uid": os.getuid(), "runtime": os.environ.get("AWS_EXECUTION_ENV")}
