extends Node

const DEFAULT_PROPERTY_NAMES := PackedStringArray([
    "visible",
    "process_mode",
    "position",
    "rotation",
    "scale",
    "global_position",
    "global_rotation",
    "global_scale"
])
const MAX_TREE_NODES := 500

var _socket := StreamPeerTCP.new()
var _read_buffer := ""
var _connected := false
var _host := ""
var _port := 0
var _token := ""

func _ready() -> void:
    _host = OS.get_environment("GODOT_MCP_LIVE_HOST")
    _token = OS.get_environment("GODOT_MCP_LIVE_TOKEN")
    _port = int(OS.get_environment("GODOT_MCP_LIVE_PORT"))

    if _host == "" or _token == "" or _port <= 0:
        set_process(false)
        return

    var error := _socket.connect_to_host(_host, _port)
    if error != OK:
        push_warning("Godot MCP bridge failed to connect to host %s:%d" % [_host, _port])
        set_process(false)
        return

    set_process(true)

func _exit_tree() -> void:
    if _connected:
        _socket.disconnect_from_host()

func _process(_delta: float) -> void:
    _socket.poll()

    if not _connected and _socket.get_status() == StreamPeerTCP.STATUS_CONNECTED:
        _connected = true
        _send_message({
            "type": "hello",
            "token": _token,
            "payload": _get_live_main_scene_payload()
        })

    if _socket.get_status() != StreamPeerTCP.STATUS_CONNECTED:
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
        "list_live_groups":
            _send_response(request_id, true, _list_live_groups_payload(params))
        "capture_debug_state":
            _send_response(request_id, true, _capture_debug_state_payload(params))
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

func _collect_property_names(node: Node, requested_names: Array) -> PackedStringArray:
    var names := PackedStringArray()
    if requested_names.size() > 0:
        for name_variant in requested_names:
            names.append(String(name_variant))
        return names

    for default_name in DEFAULT_PROPERTY_NAMES:
        names.append(default_name)
    return names

func _serialize_node_state(node: Node, params: Dictionary) -> Dictionary:
    var requested_properties: Array = params.get("property_names", [])
    if typeof(requested_properties) != TYPE_ARRAY:
        requested_properties = []

    var properties := {}
    for property_name in _collect_property_names(node, requested_properties):
        var property_value = node.get(property_name)
        properties[property_name] = _serialize_value(property_value)

    return {
        "name": node.name,
        "type": node.get_class(),
        "path": str(node.get_path()),
        "groups": node.get_groups().map(func(group): return str(group)),
        "properties": properties
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
