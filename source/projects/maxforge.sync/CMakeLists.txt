maxforge_add_external(
	DEPS ixwebsocket
	INCLUDES ${CMAKE_CURRENT_SOURCE_DIR}/../../../deps/bbb.agent/source/bbb
)

target_compile_definitions(
	${PROJECT_NAME}
	PRIVATE
	MAXFORGE_PACKAGE_VERSION="${PACKAGE_VERSION}"
)
