{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 8,
      "minor": 6,
      "revision": 4,
      "processor": "x86",
      "platform": "macintel"
    },
    "classnamespace": "box",
    "rect": [
      100,
      100,
      1080,
      620
    ],
    "bglocked": 0,
    "openrect": [
      0,
      0,
      0,
      0
    ],
    "openinpresentation": 0,
    "default_fontsize": 12,
    "default_fontface": 0,
    "default_fontname": "Arial",
    "gridonopen": 2,
    "gridsize": [
      15,
      15
    ],
    "gridsnaponopen": 0,
    "objectsnaponopen": 1,
    "statusbarvisible": 2,
    "toolbarvisible": 2,
    "lefttoolbarpinned": 0,
    "toptoolbarpinned": 0,
    "righttoolbarpinned": 0,
    "bottomtoolbarpinned": 0,
    "toolbars_unpinned_last_save": 0,
    "tallnewobj": 0,
    "boxanimatetime": 200,
    "enablehscroll": 1,
    "enablevscroll": 1,
    "devicewidth": 0,
    "description": "Agent-driven native Max patch replacement without JavaScript",
    "digest": "",
    "tags": "",
    "style": "",
    "subpatcher_template": "",
    "assistshowspatchername": 0,
    "boxes": [
      {
        "box": {
          "id": "obj-title",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            30,
            200,
            20
          ],
          "text": "maxforge MCP bridge: stdio MCP -> localhost WebSocket -> native Max SDK"
        }
      },
      {
        "box": {
          "id": "obj-requirement",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            58,
            200,
            20
          ],
          "text": "Controller patch: creates and routes independent Max windows by patcherId."
        }
      },
      {
        "box": {
          "id": "obj-ownership",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            82,
            200,
            20
          ],
          "text": "This window is maxforge_bridge; its managed scope is agent_demo."
        }
      },
      {
        "box": {
          "id": "obj-load",
          "maxclass": "newobj",
          "numinlets": 0,
          "numoutlets": 1,
          "patching_rect": [
            40,
            135,
            80,
            22
          ],
          "outlettype": [
            "bang"
          ],
          "text": "loadbang"
        }
      },
      {
        "box": {
          "id": "obj-configure_hub",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            145,
            125,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "host 127.0.0.1, port 8766"
        }
      },
      {
        "box": {
          "id": "obj-set_scope",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            145,
            160,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "scope agent_demo"
        }
      },
      {
        "box": {
          "id": "obj-set_patcher_id",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            275,
            160,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "patcher_id maxforge_bridge"
        }
      },
      {
        "box": {
          "id": "obj-enable_controller",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            465,
            160,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "controller 1"
        }
      },
      {
        "box": {
          "id": "obj-connect_delay",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            145,
            195,
            80,
            22
          ],
          "outlettype": [
            "bang"
          ],
          "text": "delay 500"
        }
      },
      {
        "box": {
          "id": "obj-connect",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            260,
            195,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "connect"
        }
      },
      {
        "box": {
          "id": "obj-hub",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            390,
            195,
            100,
            22
          ],
          "outlettype": [
            "",
            ""
          ],
          "text": "bbb.agent.hub"
        }
      },
      {
        "box": {
          "id": "obj-route_status",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            390,
            250,
            80,
            22
          ],
          "outlettype": [
            "",
            ""
          ],
          "text": "route status"
        }
      },
      {
        "box": {
          "id": "obj-is_connected",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 2,
          "patching_rect": [
            390,
            290,
            80,
            22
          ],
          "outlettype": [
            "",
            ""
          ],
          "text": "sel connected"
        }
      },
      {
        "box": {
          "id": "obj-register_patch",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            390,
            330,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "register"
        }
      },
      {
        "box": {
          "id": "obj-route_data",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            610,
            250,
            80,
            22
          ],
          "outlettype": [
            "",
            ""
          ],
          "text": "route data"
        }
      },
      {
        "box": {
          "id": "obj-prepend_apply",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            610,
            290,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "prepend apply"
        }
      },
      {
        "box": {
          "id": "obj-sync",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            610,
            330,
            100,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "maxforge.sync"
        }
      },
      {
        "box": {
          "id": "obj-route_event",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            610,
            385,
            80,
            22
          ],
          "outlettype": [
            "",
            ""
          ],
          "text": "route event"
        }
      },
      {
        "box": {
          "id": "obj-prepend_send",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            610,
            425,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "prepend send"
        }
      },
      {
        "box": {
          "id": "obj-bridge_status",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            290,
            250,
            80,
            22
          ],
          "text": "print maxforge-bridge"
        }
      },
      {
        "box": {
          "id": "obj-sync_status",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            805,
            330,
            80,
            22
          ],
          "text": "print maxforge-sync"
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "obj-load",
            0
          ],
          "destination": [
            "obj-configure_hub",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-configure_hub",
            0
          ],
          "destination": [
            "obj-hub",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-load",
            0
          ],
          "destination": [
            "obj-set_scope",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-set_scope",
            0
          ],
          "destination": [
            "obj-sync",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-load",
            0
          ],
          "destination": [
            "obj-set_patcher_id",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-set_patcher_id",
            0
          ],
          "destination": [
            "obj-sync",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-load",
            0
          ],
          "destination": [
            "obj-enable_controller",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-enable_controller",
            0
          ],
          "destination": [
            "obj-sync",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-load",
            0
          ],
          "destination": [
            "obj-connect_delay",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-connect_delay",
            0
          ],
          "destination": [
            "obj-connect",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-connect",
            0
          ],
          "destination": [
            "obj-hub",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-hub",
            0
          ],
          "destination": [
            "obj-route_status",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-route_status",
            0
          ],
          "destination": [
            "obj-is_connected",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-is_connected",
            0
          ],
          "destination": [
            "obj-register_patch",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-register_patch",
            0
          ],
          "destination": [
            "obj-sync",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-hub",
            0
          ],
          "destination": [
            "obj-bridge_status",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-hub",
            1
          ],
          "destination": [
            "obj-route_data",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-route_data",
            0
          ],
          "destination": [
            "obj-prepend_apply",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-prepend_apply",
            0
          ],
          "destination": [
            "obj-sync",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-sync",
            0
          ],
          "destination": [
            "obj-route_event",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-route_event",
            0
          ],
          "destination": [
            "obj-prepend_send",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-prepend_send",
            0
          ],
          "destination": [
            "obj-hub",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-sync",
            0
          ],
          "destination": [
            "obj-sync_status",
            0
          ]
        }
      }
    ]
  }
}