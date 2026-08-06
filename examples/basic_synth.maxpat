{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 9,
      "minor": 0,
      "revision": 0,
      "architecture": "x64",
      "modernui": 1
    },
    "classnamespace": "box",
    "rect": [
      100,
      100,
      640,
      480
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
    "description": "Simple oscillator -> gain -> DAC",
    "digest": "",
    "tags": "",
    "style": "",
    "subpatcher_template": "",
    "assistshowspatchername": 0,
    "boxes": [
      {
        "box": {
          "id": "obj-cmt",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            50,
            50,
            200,
            20
          ],
          "text": "Basic Synth: number -> mtof -> cycle~ -> *~ -> gain~ -> ezdac~"
        }
      },
      {
        "box": {
          "id": "obj-freq",
          "maxclass": "number",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            200,
            50,
            50,
            20
          ],
          "outlettype": [
            "",
            "bang"
          ]
        }
      },
      {
        "box": {
          "id": "obj-mt",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            50,
            110,
            80,
            22
          ],
          "outlettype": [
            ""
          ],
          "text": "mtof"
        }
      },
      {
        "box": {
          "id": "obj-osc",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            50,
            170,
            80,
            22
          ],
          "outlettype": [
            "signal"
          ],
          "text": "cycle~ 440"
        }
      },
      {
        "box": {
          "id": "obj-mul",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            50,
            230,
            80,
            22
          ],
          "outlettype": [
            "signal"
          ],
          "text": "*~ 0.5"
        }
      },
      {
        "box": {
          "id": "obj-vol",
          "maxclass": "gain~",
          "numinlets": 2,
          "numoutlets": 2,
          "patching_rect": [
            50,
            290,
            34,
            130
          ],
          "outlettype": [
            "signal",
            ""
          ]
        }
      },
      {
        "box": {
          "id": "obj-dac",
          "maxclass": "ezdac~",
          "numinlets": 2,
          "numoutlets": 0,
          "patching_rect": [
            50,
            350,
            52,
            36
          ]
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "obj-freq",
            0
          ],
          "destination": [
            "obj-mt",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-mt",
            0
          ],
          "destination": [
            "obj-osc",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-osc",
            0
          ],
          "destination": [
            "obj-mul",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-mul",
            0
          ],
          "destination": [
            "obj-vol",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-vol",
            0
          ],
          "destination": [
            "obj-dac",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "obj-vol",
            1
          ],
          "destination": [
            "obj-dac",
            1
          ]
        }
      }
    ]
  }
}