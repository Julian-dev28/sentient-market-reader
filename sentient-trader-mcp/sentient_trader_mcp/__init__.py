import asyncio as _asyncio
from .server import main as _async_main

__version__ = "0.1.3"


def main():
    _asyncio.run(_async_main())


__all__ = ["main"]
