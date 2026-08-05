macro(maxforge_add_external)
	cmake_parse_arguments(
		MAXFORGE_EXTERNAL
		""
		""
		"DEPS;INCLUDES;SOURCES"
		${ARGN}
	)

	if(NOT DEFINED C74_MIN_API_DIR)
		set(C74_MIN_API_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../deps/min-api")
	endif()

	if(NOT EXISTS "${C74_MIN_API_DIR}/script/min-pretarget.cmake")
		message(FATAL_ERROR "min-api is missing. Run: git submodule update --init --recursive")
	endif()

	if(NOT DEFINED C74_LIBRARY_OUTPUT_DIRECTORY)
		set(C74_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../../externals")
	endif()

	if(MAXFORGE_EXTERNAL_SOURCES)
		set(maxforge_external_sources ${MAXFORGE_EXTERNAL_SOURCES})
	else()
		file(GLOB maxforge_external_sources CONFIGURE_DEPENDS
			"${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
		)
	endif()

	include(${C74_MIN_API_DIR}/script/min-pretarget.cmake)
	add_library(${PROJECT_NAME} MODULE ${maxforge_external_sources})
	target_include_directories(${PROJECT_NAME} PRIVATE ${C74_INCLUDES})
	if(MAXFORGE_EXTERNAL_INCLUDES)
		target_include_directories(
			${PROJECT_NAME}
			PRIVATE
			${MAXFORGE_EXTERNAL_INCLUDES}
		)
	endif()
	if(MAXFORGE_EXTERNAL_DEPS)
		target_link_libraries(
			${PROJECT_NAME}
			PRIVATE
			${MAXFORGE_EXTERNAL_DEPS}
		)
	endif()
	if(APPLE)
		set(BUNDLE_IDENTIFIER "${PROJECT_NAME}")
	endif()
	include(${C74_MIN_API_DIR}/script/min-posttarget.cmake)

	unset(maxforge_external_sources)
	unset(MAXFORGE_EXTERNAL_DEPS)
	unset(MAXFORGE_EXTERNAL_INCLUDES)
	unset(MAXFORGE_EXTERNAL_SOURCES)
	unset(MAXFORGE_EXTERNAL_UNPARSED_ARGUMENTS)
	unset(MAXFORGE_EXTERNAL_KEYWORDS_MISSING_VALUES)
endmacro()
