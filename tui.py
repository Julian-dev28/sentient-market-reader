#!/usr/bin/env python3
"""
Sentient Trading TUI - Terminal User Interface
Real-time monitoring dashboard for the autonomous trading system
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
    from rich import box
    import httpx
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install rich httpx")
    sys.exit(1)

# Configuration
API_BASE = os.getenv("API_BASE", "http://localhost:3000/api")
PYTHON_API = os.getenv("PYTHON_API", "http://localhost:8001")
REFRESH_INTERVAL = 2.0  # seconds

console = Console()


class TradingDashboard:
    """Real-time trading dashboard TUI"""
    
    def __init__(self):
        self.layout = Layout()
        self.setup_layout()
        self.last_update = None
        self.error_count = 0
        
    def setup_layout(self):
        """Configure the TUI layout"""
        self.layout.split_column(
            Layout(name="header", size=3),
            Layout(name="main"),
            Layout(name="footer", size=3)
        )
        
        self.layout["main"].split_row(
            Layout(name="left"),
            Layout(name="right")
        )
        
        self.layout["left"].split_column(
            Layout(name="market", ratio=2),
            Layout(name="signal", ratio=3)
        )
        
        self.layout["right"].split_column(
            Layout(name="positions", ratio=2),
            Layout(name="trades", ratio=3)
        )
    
    def render_header(self) -> Panel:
        """Render the header panel"""
        grid = Table.grid(expand=True)
        grid.add_column(justify="left")
        grid.add_column(justify="center")
        grid.add_column(justify="right")
        
        title = Text("SENTIENT TRADING DASHBOARD", style="bold cyan")
        status = "🟢 LIVE" if self.error_count < 3 else "🔴 ERROR"
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        
        grid.add_row(
            f"Status: {status}",
            title,
            f"Updated: {timestamp}"
        )
        
        return Panel(grid, style="white on blue")
    
    def render_footer(self) -> Panel:
        """Render the footer panel"""
        grid = Table.grid(expand=True)
        grid.add_column(justify="left")
        grid.add_column(justify="right")
        
        grid.add_row(
            "Press Ctrl+C to exit",
            f"Refresh: {REFRESH_INTERVAL}s | Errors: {self.error_count}"
        )
        
        return Panel(grid, style="white on blue")
    
    async def fetch_market_data(self) -> Optional[dict]:
        """Fetch current market data"""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                # Try to get BTC price
                btc_resp = await client.get(f"{API_BASE}/btc-price")
                btc_data = btc_resp.json() if btc_resp.status_code == 200 else {}
                
                # Try to get market info
                try:
                    markets_resp = await client.get(f"{API_BASE}/markets")
                    markets_data = markets_resp.json() if markets_resp.status_code == 200 else {}
                except:
                    markets_data = {}
                
                return {
                    "btc_price": btc_data.get("price"),
                    "markets": markets_data.get("markets", [])
                }
        except Exception as e:
            return {"error": str(e)}
    
    async def fetch_balance(self) -> Optional[dict]:
        """Fetch account balance"""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{API_BASE}/balance")
                return resp.json() if resp.status_code == 200 else {}
        except:
            return {}
    
    async def fetch_positions(self) -> list:
        """Fetch open positions"""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{API_BASE}/positions")
                data = resp.json() if resp.status_code == 200 else {}
                return data.get("positions", [])
        except:
            return []
    
    async def fetch_trades(self) -> list:
        """Fetch recent trades"""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{API_BASE}/trade-log")
                data = resp.json() if resp.status_code == 200 else {}
                return data.get("trades", [])[:10]  # Last 10 trades
        except:
            return []
    
    def render_market_panel(self, data: dict) -> Panel:
        """Render market information panel"""
        table = Table(box=box.SIMPLE, show_header=False, expand=True)
        table.add_column("Key", style="cyan")
        table.add_column("Value", style="white")
        
        if data.get("error"):
            table.add_row("Error", str(data["error"]))
        else:
            btc_price = data.get("btc_price")
            if btc_price:
                table.add_row("BTC Price", f"${btc_price:,.2f}")
            
            markets = data.get("markets", [])
            if markets:
                active = [m for m in markets if m.get("status") == "open"]
                table.add_row("Active Markets", str(len(active)))
                if active:
                    latest = active[0]
                    table.add_row("Current Market", latest.get("ticker", "N/A"))
                    table.add_row("Strike", f"${latest.get('floor_strike', 0):,.0f}")
                    table.add_row("Yes Ask", f"{latest.get('yes_ask', 0)}¢")
                    table.add_row("No Ask", f"{latest.get('no_ask', 0)}¢")
        
        return Panel(table, title="📊 Market Data", border_style="green")
    
    def render_signal_panel(self, balance: dict) -> Panel:
        """Render signal/status panel"""
        table = Table(box=box.SIMPLE, show_header=False, expand=True)
        table.add_column("Key", style="cyan")
        table.add_column("Value", style="white")
        
        table.add_row("Balance", f"${balance.get('balance', 0):.2f}")
        table.add_row("Available", f"${balance.get('available', 0):.2f}")
        
        # Add signal status if available
        table.add_row("─" * 20, "─" * 20)
        table.add_row("Signal Status", "Monitoring...")
        
        return Panel(table, title="🎯 Signal & Balance", border_style="yellow")
    
    def render_positions_panel(self, positions: list) -> Panel:
        """Render positions panel"""
        table = Table(box=box.SIMPLE, expand=True)
        table.add_column("Ticker", style="cyan")
        table.add_column("Side", style="white")
        table.add_column("Qty", justify="right")
        table.add_column("Value", justify="right", style="green")
        
        if not positions:
            table.add_row("No open positions", "", "", "")
        else:
            for pos in positions[:5]:  # Show top 5
                ticker = pos.get("ticker", "")[:15]
                side = pos.get("side", "").upper()
                qty = pos.get("contracts", pos.get("position", 0))
                value = pos.get("market_value", pos.get("value", 0))
                
                side_style = "green" if side == "YES" else "red"
                table.add_row(
                    ticker,
                    f"[{side_style}]{side}[/{side_style}]",
                    str(qty),
                    f"${value:.2f}"
                )
        
        return Panel(table, title="📈 Positions", border_style="blue")
    
    def render_trades_panel(self, trades: list) -> Panel:
        """Render recent trades panel"""
        table = Table(box=box.SIMPLE, expand=True)
        table.add_column("Time", style="dim")
        table.add_column("Side", style="white")
        table.add_column("Price", justify="right")
        table.add_column("P&L", justify="right")
        
        if not trades:
            table.add_row("No recent trades", "", "", "")
        else:
            for trade in trades:
                # Parse timestamp
                ts = trade.get("timestamp", trade.get("createdAt", ""))
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    time_str = dt.strftime("%H:%M:%S")
                except:
                    time_str = "N/A"
                
                side = trade.get("side", "").upper()
                price = trade.get("limit_price", trade.get("price", 0))
                pnl = trade.get("pnl", trade.get("profit", 0))
                
                side_style = "green" if side == "YES" else "red"
                pnl_style = "green" if pnl > 0 else "red" if pnl < 0 else "white"
                
                table.add_row(
                    time_str,
                    f"[{side_style}]{side}[/{side_style}]",
                    f"{price}¢",
                    f"[{pnl_style}]{pnl:+.2f}[/{pnl_style}]"
                )
        
        return Panel(table, title="📝 Recent Trades", border_style="magenta")
    
    async def fetch_all_data(self) -> dict:
        """Fetch all dashboard data"""
        market_data, balance, positions, trades = await asyncio.gather(
            self.fetch_market_data(),
            self.fetch_balance(),
            self.fetch_positions(),
            self.fetch_trades(),
            return_exceptions=True
        )
        
        return {
            "market": market_data if not isinstance(market_data, Exception) else {"error": str(market_data)},
            "balance": balance if not isinstance(balance, Exception) else {},
            "positions": positions if not isinstance(positions, Exception) else [],
            "trades": trades if not isinstance(trades, Exception) else []
        }
    
    async def render(self) -> Layout:
        """Render the complete dashboard"""
        try:
            data = await self.fetch_all_data()
            
            self.layout["header"].update(self.render_header())
            self.layout["market"].update(self.render_market_panel(data["market"]))
            self.layout["signal"].update(self.render_signal_panel(data["balance"]))
            self.layout["positions"].update(self.render_positions_panel(data["positions"]))
            self.layout["trades"].update(self.render_trades_panel(data["trades"]))
            self.layout["footer"].update(self.render_footer())
            
            self.error_count = max(0, self.error_count - 1)
            
        except Exception as e:
            self.error_count += 1
            console.print(f"[red]Error rendering dashboard: {e}[/red]")
        
        return self.layout


async def main():
    """Main TUI loop"""
    dashboard = TradingDashboard()
    
    console.print("[bold cyan]Starting Sentient Trading TUI...[/bold cyan]")
    console.print(f"API Base: {API_BASE}")
    console.print(f"Python API: {PYTHON_API}\n")
    
    try:
        with Live(await dashboard.render(), console=console, refresh_per_second=4, screen=True):
            while True:
                await asyncio.sleep(REFRESH_INTERVAL)
                await dashboard.render()
    except KeyboardInterrupt:
        console.print("\n[yellow]Dashboard stopped by user[/yellow]")
    except Exception as e:
        console.print(f"\n[red]Dashboard error: {e}[/red]")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
