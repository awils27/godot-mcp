extends Node2D

func _ready() -> void:
    add_to_group("roots")
    $Player.add_to_group("actors")
