"""Entry point of the voice server: `python -u src/voice_server.py`."""
import asyncio

from voice.server import main

if __name__ == "__main__":
    asyncio.run(main())
