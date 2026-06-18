extends Node2D

@export var train_name: String = "Comet"
var runtime_status: String = "booting"

func _ready() -> void:
    add_to_group("roots")
    $Player.add_to_group("actors")
    runtime_status = "ready"
