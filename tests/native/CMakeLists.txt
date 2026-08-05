add_executable(
	maxforge_sync_protocol_test
	maxforge_sync_protocol_test.cpp
	${CMAKE_CURRENT_SOURCE_DIR}/../../source/projects/maxforge.sync/maxforge_sync_protocol.cpp
)
target_include_directories(
	maxforge_sync_protocol_test
	PRIVATE
	${CMAKE_CURRENT_SOURCE_DIR}/../../source/projects/maxforge.sync
)
target_compile_features(maxforge_sync_protocol_test PRIVATE cxx_std_17)

add_test(
	NAME maxforge_sync_protocol
	COMMAND maxforge_sync_protocol_test
)
