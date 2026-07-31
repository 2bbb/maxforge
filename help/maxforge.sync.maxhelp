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
      940,
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
    "description": "Apply a managed PatchPlan without node.script or thispatcher",
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
            35,
            200,
            20
          ],
          "text": "maxforge.sync: native external PatchPlan demo"
        }
      },
      {
        "box": {
          "id": "obj-step1",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            70,
            200,
            20
          ],
          "text": "The plan is imported and applied automatically. The buttons let you retry and inspect stale-revision rejection."
        }
      },
      {
        "box": {
          "id": "obj-step2",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            40,
            95,
            200,
            20
          ],
          "text": "The generated boxes use scope sync_demo; these controls and maxforge.sync itself remain unmanaged."
        }
      },
      {
        "box": {
          "id": "obj-import",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            40,
            145,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "import managed_plan.json"
        }
      },
      {
        "box": {
          "id": "obj-plan",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            250,
            145,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "dict maxforge_sync_demo_plan",
          "embed": 0
        }
      },
      {
        "box": {
          "id": "obj-apply",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            40,
            185,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "applydict maxforge_sync_demo_plan"
        }
      },
      {
        "box": {
          "id": "obj-revision",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            40,
            225,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "revision"
        }
      },
      {
        "box": {
          "id": "obj-load",
          "maxclass": "newobj",
          "numinlets": 0,
          "numoutlets": 1,
          "patching_rect": [
            250,
            175,
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
          "id": "obj-set_scope",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            330,
            175,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "scope sync_demo"
        }
      },
      {
        "box": {
          "id": "obj-delay",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            440,
            175,
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
          "id": "obj-sync",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            250,
            225,
            80,
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
          "id": "obj-status",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            500,
            205,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "print maxforge-sync-status"
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "obj-import",
            0
          ],
          "destination": [
            "obj-plan",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-apply",
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
            "obj-revision",
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
            "obj-import",
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
            "obj-delay",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-delay",
            0
          ],
          "destination": [
            "obj-apply",
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
            "obj-status",
            0
          ]
        }
      }
    ]
  }
}