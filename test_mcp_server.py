#!/usr/bin/env python3
"""
Test script for sentient-trader MCP server
Verifies the MCP server can be imported and lists available tools
"""

import asyncio
import sys

async def test_mcp_server():
    """Test the MCP server by importing it and checking available tools."""
    print("Testing sentient-trader MCP server...\n")
    
    try:
        # Import the server module
        from sentient_trader_mcp import server as mcp_server
        print("✓ Successfully imported sentient_trader_mcp.server")
        
        # Check if the server instance exists
        if hasattr(mcp_server, 'server'):
            print("✓ Server instance found")
            server = mcp_server.server
            print(f"  Server name: {server.name}")
        else:
            print("✗ No server instance found")
            return False
        
        # List available tools
        print("\nAvailable MCP Tools:")
        print("-" * 60)
        
        tools = await mcp_server.list_tools()
        
        if not tools:
            print("No tools found")
            return False
        
        for i, tool in enumerate(tools, 1):
            print(f"\n{i}. {tool.name}")
            print(f"   Description: {tool.description}")
            if hasattr(tool, 'inputSchema') and tool.inputSchema:
                schema = tool.inputSchema
                required = schema.get('required', [])
                props = schema.get('properties', {})
                if required:
                    print(f"   Required params: {', '.join(required)}")
                if props:
                    print(f"   Parameters: {', '.join(props.keys())}")
        
        print("\n" + "=" * 60)
        print(f"✓ Found {len(tools)} tools")
        print("✓ MCP server is properly configured and functional")
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import sentient_trader_mcp: {e}")
        print("\nMake sure the package is installed:")
        print("  pip install sentient-trader-mcp")
        return False
    except Exception as e:
        print(f"✗ Error testing MCP server: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = asyncio.run(test_mcp_server())
    sys.exit(0 if success else 1)
