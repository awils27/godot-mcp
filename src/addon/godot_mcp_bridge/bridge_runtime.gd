extends Node

const DEFAULT_PROPERTY_NAMES := [
    "visible",
    "process_mode",
    "position",
    "rotation",
    "scale",
    "global_position",
    "global_rotation",
    "global_scale"
]
const MAX_TREE_NODES := 500
const CONNECT_RETRY_INTERVAL_MS := 1000
const SESSION_FILE_PATH := "res://addons/godot_mcp_bridge/session.json"

var _socket := StreamPeerTCP.new()
var _read_buffer := ""
var _connected := false
var _host := ""
var _port := 0
var _token := ""
var _use_environment_settings := false
var _next_connect_attempt_msec := 0

func _ready() -> void:
    _host = OS.get_environment("GODOT_MCP_LIVE_HOST")
    _token = OS.get_environment("GODOT_MCP_LIVE_TOKEN")
    _port = int(OS.get_environment("GODOT_MCP_LIVE_PORT"))
    _use_environment_settings = _host != "" and _token != "" and _port > 0

    set_process(true)

func _exit_tree() -> void:
    if _connected:
        _socket.disconnect_from_host()

func _process(_delta: float) -> void:
    if _socket.get_status() == StreamPeerTCP.STATUS_NONE:
        _connected = false

    _socket.poll()
    if _socket.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        _connected = false

    if not _connected and _socket.get_status() == StreamPeerTCP.STATUS_CONNECTED:
        _connected = true
        _send_message({
            "type": "hello",
            "token": _token,
            "payload": _get_live_main_scene_payload()
        })

    if _socket.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        _maybe_connect()
        return

    var available := _socket.get_available_bytes()
    if available <= 0:
        return

    _read_buffer += _socket.get_utf8_string(available)
    while true:
        var newline_index := _read_buffer.find("\n")
        if newline_index == -1:
            break

        var line := _read_buffer.substr(0, newline_index).strip_edges()
        _read_buffer = _read_buffer.substr(newline_index + 1)
        if line == "":
            continue

        var parsed = JSON.parse_string(line)
        if typeof(parsed) != TYPE_DICTIONARY:
            continue

        _handle_request(parsed)

func _has_connection_settings() -> bool:
    return _host != "" and _token != "" and _port > 0

func _maybe_connect() -> void:
    var now := Time.get_ticks_msec()
    if now < _next_connect_attempt_msec:
        return

    _next_connect_attempt_msec = now + CONNECT_RETRY_INTERVAL_MS
    if not _use_environment_settings:
        _load_session_settings()
    if not _has_connection_settings():
        return

    _socket = StreamPeerTCP.new()
    var error := _socket.connect_to_host(_host, _port)
    if error != OK:
        _connected = false

func _load_session_settings() -> void:
    if not FileAccess.file_exists(SESSION_FILE_PATH):
        return

    var file := FileAccess.open(SESSION_FILE_PATH, FileAccess.READ)
    if file == null:
        return

    var parsed = JSON.parse_string(file.get_as_text())
    if typeof(parsed) != TYPE_DICTIONARY:
        return

    var session := parsed as Dictionary
    var session_host := String(session.get("host", ""))
    var session_token := String(session.get("token", ""))
    var session_port := int(session.get("port", 0))
    if session_host == "" or session_token == "" or session_port <= 0:
        return

    _host = session_host
    _token = session_token
    _port = session_port

func _handle_request(message: Dictionary) -> void:
    var request_id := String(message.get("request_id", ""))
    var command := String(message.get("command", ""))
    var token := String(message.get("token", ""))
    var params := message.get("params", {})
    if typeof(params) != TYPE_DICTIONARY:
        params = {}

    if token != _token:
        _send_response(request_id, false, null, "Invalid live bridge token.")
        return

    match command:
        "get_live_main_scene":
            _send_response(request_id, true, _get_live_main_scene_payload())
        "get_live_scene_tree":
            _send_payload_response(request_id, _get_live_scene_tree_payload(params))
        "get_live_node_state":
            _send_payload_response(request_id, _get_live_node_state_payload(params))
        "get_live_property_list":
            _send_payload_response(request_id, _get_live_property_list_payload(params))
        "get_live_script_variables":
            _send_payload_response(request_id, _get_live_script_variables_payload(params))
        "list_live_groups":
            _send_response(request_id, true, _list_live_groups_payload(params))
        "capture_debug_state":
            _send_response(request_id, true, _capture_debug_state_payload(params))
        "capture_runtime_state":
            _send_payload_response(request_id, _capture_runtime_state_payload(params))
        _:
            _send_response(request_id, false, null, "Unknown live bridge command: " + command)

func _send_response(request_id: String, success: bool, payload = null, error_message: String = "") -> void:
    _send_message({
        "request_id": request_id,
        "success": success,
        "payload": payload,
        "error": error_message,
        "token": _token
    })

func _send_payload_response(request_id: String, payload) -> void:
    if typeof(payload) == TYPE_DICTIONARY and payload.has("error"):
        _send_response(request_id, false, null, String(payload.get("error", "Unknown live bridge error.")))
        return
    _send_response(request_id, true, payload)

func _send_message(message: Dictionary) -> void:
    if _socket.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        return
    var serialized := JSON.stringify(message) + "\n"
    _socket.put_data(serialized.to_utf8_buffer())

func _get_current_scene() -> Node:
    return get_tree().current_scene

func _get_live_main_scene_payload() -> Dictionary:
    var current_scene := _get_current_scene()
    var scene_path = null
    if current_scene != null:
        scene_path = current_scene.scene_file_path
    return {
        "currentSceneName": current_scene.name if current_scene != null else null,
        "currentScenePath": scene_path
    }

func _resolve_node(params: Dictionary) -> Node:
    var current_scene := _get_current_scene()
    if current_scene == null:
        return null

    var node_path := String(params.get("root_node_path", params.get("node_path", "")))
    if node_path == "" or node_path == ".":
        return current_scene
    if node_path.begins_with("/"):
        return get_tree().root.get_node_or_null(node_path)
    return current_scene.get_node_or_null(node_path)

func _serialize_value(value):
    match typeof(value):
        TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
            return value
        TYPE_VECTOR2:
            return { "x": value.x, "y": value.y }
        TYPE_VECTOR3:
            return { "x": value.x, "y": value.y, "z": value.z }
        TYPE_COLOR:
            return { "r": value.r, "g": value.g, "b": value.b, "a": value.a }
        TYPE_RECT2:
            return {
                "position": _serialize_value(value.position),
                "size": _serialize_value(value.size)
            }
        TYPE_TRANSFORM2D:
            return {
                "x": _serialize_value(value.x),
                "y": _serialize_value(value.y),
                "origin": _serialize_value(value.origin)
            }
        TYPE_ARRAY:
            var serialized_array: Array = []
            for item in value:
                serialized_array.append(_serialize_value(item))
            return serialized_array
        TYPE_DICTIONARY:
            var serialized_dict := {}
            for key in value.keys():
                serialized_dict[str(key)] = _serialize_value(value[key])
            return serialized_dict
        TYPE_OBJECT:
            if value is Resource:
                return { "resourcePath": value.resource_path, "type": value.get_class() }
            if value is Node:
                return { "nodePath": str(value.get_path()), "type": value.get_class() }
            return { "type": value.get_class() }
        _:
            return str(value)

func _type_name_from_id(type_id: int) -> String:
    match type_id:
        TYPE_NIL:
            return "nil"
        TYPE_BOOL:
            return "bool"
        TYPE_INT:
            return "int"
        TYPE_FLOAT:
            return "float"
        TYPE_STRING:
            return "String"
        TYPE_VECTOR2:
            return "Vector2"
        TYPE_VECTOR2I:
            return "Vector2i"
        TYPE_RECT2:
            return "Rect2"
        TYPE_RECT2I:
            return "Rect2i"
        TYPE_VECTOR3:
            return "Vector3"
        TYPE_VECTOR3I:
            return "Vector3i"
        TYPE_TRANSFORM2D:
            return "Transform2D"
        TYPE_VECTOR4:
            return "Vector4"
        TYPE_VECTOR4I:
            return "Vector4i"
        TYPE_PLANE:
            return "Plane"
        TYPE_QUATERNION:
            return "Quaternion"
        TYPE_AABB:
            return "AABB"
        TYPE_BASIS:
            return "Basis"
        TYPE_TRANSFORM3D:
            return "Transform3D"
        TYPE_PROJECTION:
            return "Projection"
        TYPE_COLOR:
            return "Color"
        TYPE_STRING_NAME:
            return "StringName"
        TYPE_NODE_PATH:
            return "NodePath"
        TYPE_RID:
            return "RID"
        TYPE_OBJECT:
            return "Object"
        TYPE_CALLABLE:
            return "Callable"
        TYPE_SIGNAL:
            return "Signal"
        TYPE_DICTIONARY:
            return "Dictionary"
        TYPE_ARRAY:
            return "Array"
        TYPE_PACKED_BYTE_ARRAY:
            return "PackedByteArray"
        TYPE_PACKED_INT32_ARRAY:
            return "PackedInt32Array"
        TYPE_PACKED_INT64_ARRAY:
            return "PackedInt64Array"
        TYPE_PACKED_FLOAT32_ARRAY:
            return "PackedFloat32Array"
        TYPE_PACKED_FLOAT64_ARRAY:
            return "PackedFloat64Array"
        TYPE_PACKED_STRING_ARRAY:
            return "PackedStringArray"
        TYPE_PACKED_VECTOR2_ARRAY:
            return "PackedVector2Array"
        TYPE_PACKED_VECTOR3_ARRAY:
            return "PackedVector3Array"
        TYPE_PACKED_COLOR_ARRAY:
            return "PackedColorArray"
        _:
            return str(type_id)

func _collect_property_names(node: Node, requested_names: Array) -> PackedStringArray:
    var names := PackedStringArray()
    if requested_names.size() > 0:
        for name_variant in requested_names:
            names.append(String(name_variant))
        return names

    for default_name in DEFAULT_PROPERTY_NAMES:
        names.append(default_name)
    return names

func _get_node_property_value(node: Node, property_name: String):
    match property_name:
        "visible":
            if node is CanvasItem or node is Node3D:
                return node.visible
        "process_mode":
            return node.process_mode
        "position":
            if node is Node2D or node is Node3D:
                return node.position
        "rotation":
            if node is Node2D or node is Node3D:
                return node.rotation
        "scale":
            if node is Node2D or node is Node3D:
                return node.scale
        "global_position":
            if node is Node2D or node is Node3D:
                return node.global_position
        "global_rotation":
            if node is Node2D or node is Node3D:
                return node.global_rotation
        "global_scale":
            if node is Node2D:
                return node.global_transform.get_scale()
            if node is Node3D:
                return node.global_transform.basis.get_scale()

    return node.get(property_name)

func _get_node_property_entries(node: Node) -> Array[Dictionary]:
    var entries: Array[Dictionary] = []
    for property_variant in node.get_property_list():
        if typeof(property_variant) != TYPE_DICTIONARY:
            continue
        entries.append(property_variant)
    return entries

func _matches_property_filter(property_entry: Dictionary, requested_names: Array) -> bool:
    if requested_names.is_empty():
        return true
    var property_name := String(property_entry.get("name", ""))
    return requested_names.has(property_name)

func _is_script_property(property_entry: Dictionary) -> bool:
    var usage := int(property_entry.get("usage", 0))
    return (usage & PROPERTY_USAGE_SCRIPT_VARIABLE) != 0

func _serialize_property_entry(property_entry: Dictionary, include_value: bool, node: Node) -> Dictionary:
    var property_name := String(property_entry.get("name", ""))
    var serialized := {
        "name": property_name,
        "type": _type_name_from_id(int(property_entry.get("type", TYPE_NIL))),
        "typeId": int(property_entry.get("type", TYPE_NIL)),
        "usage": int(property_entry.get("usage", 0)),
        "hint": int(property_entry.get("hint", 0)),
        "hintString": String(property_entry.get("hint_string", "")),
    }
    if property_entry.has("class_name"):
        serialized["className"] = String(property_entry.get("class_name", ""))
    if include_value:
        serialized["value"] = _serialize_value(_get_node_property_value(node, property_name))
    return serialized

func _serialize_node_state(node: Node, params: Dictionary) -> Dictionary:
    var requested_properties: Array = params.get("property_names", [])
    if typeof(requested_properties) != TYPE_ARRAY:
        requested_properties = []

    var properties := {}
    for property_name in _collect_property_names(node, requested_properties):
        var property_value = _get_node_property_value(node, property_name)
        properties[property_name] = _serialize_value(property_value)

    return {
        "name": node.name,
        "type": node.get_class(),
        "path": str(node.get_path()),
        "groups": node.get_groups().map(func(group): return str(group)),
        "properties": properties
    }

func _get_node_paths_from_params(params: Dictionary) -> Array[String]:
    var node_paths: Array[String] = []
    var requested_paths = params.get("node_paths", [])
    if typeof(requested_paths) == TYPE_ARRAY:
        for path_variant in requested_paths:
            node_paths.append(String(path_variant))
    return node_paths

func _limit_property_list_entries(entries: Array, max_entries: int) -> Dictionary:
    if max_entries <= 0 or entries.size() <= max_entries:
        return {
            "entries": entries,
            "truncated": false
        }
    return {
        "entries": entries.slice(0, max_entries),
        "truncated": true
    }

func _get_live_property_list_payload(params: Dictionary) -> Dictionary:
    var node := _resolve_node(params)
    if node == null:
        return {
            "error": "Target node not found in the live scene tree."
        }

    var requested_names: Array = params.get("property_names", [])
    if typeof(requested_names) != TYPE_ARRAY:
        requested_names = []
    var include_values := bool(params.get("include_values", false))
    var script_only := bool(params.get("script_only", false))

    var properties: Array = []
    for property_entry in _get_node_property_entries(node):
        if script_only and not _is_script_property(property_entry):
            continue
        if not _matches_property_filter(property_entry, requested_names):
            continue
        properties.append(_serialize_property_entry(property_entry, include_values, node))

    return {
        "currentScene": _get_live_main_scene_payload(),
        "nodePath": str(node.get_path()),
        "nodeType": node.get_class(),
        "properties": properties
    }

func _get_live_script_variables_payload(params: Dictionary) -> Dictionary:
    var node := _resolve_node(params)
    if node == null:
        return {
            "error": "Target node not found in the live scene tree."
        }

    var requested_names: Array = params.get("variable_names", params.get("property_names", []))
    if typeof(requested_names) != TYPE_ARRAY:
        requested_names = []

    var variable_entries: Array = []
    var variables := {}
    for property_entry in _get_node_property_entries(node):
        if not _is_script_property(property_entry):
            continue
        if not _matches_property_filter(property_entry, requested_names):
            continue

        var serialized_entry := _serialize_property_entry(property_entry, true, node)
        variable_entries.append(serialized_entry)
        variables[serialized_entry["name"]] = serialized_entry["value"]

    var script = node.get_script()
    var script_info = null
    if script is Script:
        script_info = {
            "className": script.get_global_name(),
            "resourcePath": script.resource_path
        }

    return {
        "currentScene": _get_live_main_scene_payload(),
        "nodePath": str(node.get_path()),
        "nodeType": node.get_class(),
        "script": script_info,
        "variables": variables,
        "propertyList": variable_entries
    }

func _build_live_scene_tree(node: Node, include_owner: bool, counters: Dictionary) -> Dictionary:
    counters["count"] += 1
    var result := {
        "name": node.name,
        "type": node.get_class(),
        "path": str(node.get_path()),
        "children": []
    }

    if include_owner and node.owner != null:
        result["owner"] = str(node.owner.get_path())

    if counters["count"] >= counters["limit"]:
        result["truncated"] = true
        return result

    var children: Array = []
    for child in node.get_children():
        if child is Node:
            if counters["count"] >= counters["limit"]:
                result["truncated"] = true
                break
            children.append(_build_live_scene_tree(child, include_owner, counters))
    result["children"] = children
    return result

func _get_live_scene_tree_payload(params: Dictionary) -> Dictionary:
    var node := _resolve_node(params)
    if node == null:
        return {
            "error": "No live scene or target node is available."
        }

    var limit := int(params.get("max_nodes", MAX_TREE_NODES))
    limit = maxi(1, mini(MAX_TREE_NODES, limit))
    var counters := { "count": 0, "limit": limit }
    return {
        "currentScene": _get_live_main_scene_payload(),
        "tree": _build_live_scene_tree(node, bool(params.get("include_owner", false)), counters),
        "truncated": counters["count"] >= counters["limit"]
    }

func _get_live_node_state_payload(params: Dictionary) -> Dictionary:
    var node := _resolve_node(params)
    if node == null:
        return {
            "error": "Target node not found in the live scene tree."
        }
    return {
        "currentScene": _get_live_main_scene_payload(),
        "node": _serialize_node_state(node, params)
    }

func _list_live_groups_payload(params: Dictionary) -> Dictionary:
    var current_scene := _get_current_scene()
    if current_scene == null:
        return {
            "groups": {},
            "currentScene": _get_live_main_scene_payload()
        }

    var include_members := bool(params.get("include_members", true))
    var groups := {}
    var stack: Array[Node] = [current_scene]
    while stack.size() > 0:
        var node := stack.pop_back()
        for group_variant in node.get_groups():
            var group_name := str(group_variant)
            if not groups.has(group_name):
                groups[group_name] = []
            if include_members:
                groups[group_name].append(str(node.get_path()))
        for child in node.get_children():
            if child is Node:
                stack.append(child)
    return {
        "currentScene": _get_live_main_scene_payload(),
        "groups": groups
    }

func _capture_debug_state_payload(params: Dictionary) -> Dictionary:
    var payload := {
        "currentScene": _get_live_main_scene_payload(),
        "sceneTree": _get_live_scene_tree_payload(params)
    }

    var node := _resolve_node(params)
    if node != null:
        payload["nodeState"] = _serialize_node_state(node, params)

    payload["groups"] = _list_live_groups_payload({"include_members": true}).get("groups", {})
    return payload

func _capture_runtime_state_payload(params: Dictionary) -> Dictionary:
    var current_scene := _get_current_scene()
    if current_scene == null:
        return {
            "error": "No live scene is available."
        }

    var payload := {
        "currentScene": _get_live_main_scene_payload(),
        "sceneTree": _get_live_scene_tree_payload(params),
    }

    var selected_node_paths := _get_node_paths_from_params(params)
    if selected_node_paths.is_empty():
        selected_node_paths.append(String(params.get("root_node_path", ".")))

    var include_script_variables := bool(params.get("include_script_variables", true))
    var include_property_list := bool(params.get("include_property_list", false))
    var max_variables_per_node := int(params.get("max_variables_per_node", 50))
    if max_variables_per_node <= 0:
        max_variables_per_node = 50

    var nodes: Array = []
    for requested_node_path in selected_node_paths:
        var node_params := params.duplicate(true)
        node_params.erase("root_node_path")
        node_params["node_path"] = requested_node_path
        var node := _resolve_node(node_params)
        if node == null:
            nodes.append({
                "nodePath": requested_node_path,
                "error": "Target node not found in the live scene tree."
            })
            continue

        var node_snapshot := {
            "nodePath": str(node.get_path()),
            "nodeState": _serialize_node_state(node, params),
        }

        if include_script_variables:
            var script_payload := _get_live_script_variables_payload(node_params)
            var limited_variables := _limit_property_list_entries(script_payload.get("propertyList", []), max_variables_per_node)
            node_snapshot["script"] = script_payload.get("script", null)
            node_snapshot["variables"] = script_payload.get("variables", {})
            node_snapshot["variableList"] = limited_variables["entries"]
            node_snapshot["variablesTruncated"] = limited_variables["truncated"]

        if include_property_list:
            var property_payload := _get_live_property_list_payload(node_params)
            var limited_properties := _limit_property_list_entries(property_payload.get("properties", []), max_variables_per_node)
            node_snapshot["propertyList"] = limited_properties["entries"]
            node_snapshot["propertyListTruncated"] = limited_properties["truncated"]

        nodes.append(node_snapshot)

    payload["nodes"] = nodes
    payload["groups"] = _list_live_groups_payload({
        "include_members": bool(params.get("include_members", true))
    }).get("groups", {})
    return payload
