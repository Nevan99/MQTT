import json, time
from datetime import datetime, timedelta, timezone
import paho.mqtt.client as mqtt

BROKER_HOST = "192.168.150.20"
BROKER_PORT = 1883


CMD_TOPIC_ALL = "test/all/cmd"
RESULT_WILDCARD = "test/+/result"
STATUS_WILDCARD = "test/+/status"

results = []

def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f'controller connected, rc={reason_code}')
    client.subscribe(RESULT_WILDCARD, qos=1)
    client.subscribe(STATUS_WILDCARD, qos=1)
 
 
def on_message(client, userdata, msg):
    pi_id = msg.topic.split("/")[1]
    if msg.topic.endswith("/status"):
        print(f"[status] {pi_id}: {msg.payload.decode()}")
        return
    data = json.loads(msg.payload.decode())
    print(f"[result] {pi_id}: {data}")
    results.append(data)

def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f"controller connected, rc={reason_code}")
    client.subscribe(RESULT_WILDCARD, qos=1)
    client.subscribe(STATUS_WILDCARD, qos=1)
 
 
def on_message(client, userdata, msg):
    pi_id = msg.topic.split("/")[1]
    if msg.topic.endswith("/status"):
        print(f"[status] {pi_id}: {msg.payload.decode()}")
        return
    data = json.loads(msg.payload.decode())
    print(f"[result] {pi_id}: {data}")
    results.append(data)

client = mqtt.Client(client_id="controller", protocol=mqtt.MQTTv5)
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
client.loop_start()

start_at = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
 
command = {
    "action": "throughput_test",
    "duration": 10,
    "at": start_at,
}

client.publish(CMD_TOPIC_ALL, json.dumps(command), qos=1)
print(f"broadcast sent, tests start at {start_at}")

time.sleep(20)
client.loop_stop()
 
print(f"\ncollected {len(results)} results:")
for r in results:
    print(r)