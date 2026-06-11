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
      900,
      560
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
    "description": "Use node.script to compile DSL and create objects through thispatcher",
    "digest": "",
    "tags": "",
    "style": "",
    "subpatcher_template": "",
    "assistshowspatchername": 0,
    "boxes": [
      {
        "box": {
          "id": "obj-1",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            35,
            200,
            20
          ],
          "text": "maxforge node.script -> thispatcher demo"
        }
      },
      {
        "box": {
          "id": "obj-2",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            70,
            200,
            20
          ],
          "text": "Before opening: run npm install && npm run build at the repository root."
        }
      },
      {
        "box": {
          "id": "obj-3",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            95,
            200,
            20
          ],
          "text": "Click generate. node.script reads generated_patch.maxdsl, compiles it with maxforge, then sends script messages to thispatcher."
        }
      },
      {
        "box": {
          "id": "obj-4",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            120,
            200,
            20
          ],
          "text": "Click clear after generate to remove the generated boxes from this patcher."
        }
      },
      {
        "box": {
          "id": "obj-5",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            40,
            175,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "generate"
        }
      },
      {
        "box": {
          "id": "obj-6",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            40,
            215,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "clear"
        }
      },
      {
        "box": {
          "id": "obj-7",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            170,
            195,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "node.script maxforge_node_script_demo.cjs",
          "watch": 1
        }
      },
      {
        "box": {
          "id": "obj-8",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            430,
            195,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "thispatcher"
        }
      },
      {
        "box": {
          "id": "obj-9",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            265,
            200,
            20
          ],
          "text": "Open the Max Console for maxforge status/errors."
        }
      },
      {
        "box": {
          "id": "obj-10",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            430,
            235,
            200,
            20
          ],
          "text": "Generated objects appear in this same patcher."
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "obj-5",
            0
          ],
          "destination": [
            "obj-7",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-6",
            0
          ],
          "destination": [
            "obj-7",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-7",
            0
          ],
          "destination": [
            "obj-8",
            0
          ]
        }
      }
    ]
  }
}