# Entry point only - all actual agent behavior lives in the agent/ package
# next to this file (agent/core.py assembles PiAgent from the mixins in
# agent/wifi.py, wifi_scan.py, interfaces.py, streaming.py, webui_proxy.py).
# Kept as pi_agent.py, not renamed, since pi-agent.service's ExecStart
# points at this exact filename.
import asyncio

from agent import PiAgent

if __name__ == "__main__":
    try:
        asyncio.run(PiAgent().start())
    except KeyboardInterrupt:
        pass
