macro(maxforge_add_external)
	if(NOT DEFINED C74_MIN_API_DIR)
		set(C74_MIN_API_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../deps/min-api")
	endif()

	if(NOT EXISTS "${C74_MIN_API_DIR}/script/min-pretarget.cmake")
		message(FATAL_ERROR "min-api is missing. Run: git submodule update --init --recursive")
	endif()

	if(NOT DEFINED C74_LIBRARY_OUTPUT_DIRECTORY)
		set(C74_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../../externals")
	endif()

	file(GLOB maxforge_external_sources CONFIGURE_DEPENDS
		"${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
	)

	include(${C74_MIN_API_DIR}/script/min-pretarget.cmake)
	add_library(${PROJECT_NAME} MODULE ${maxforge_external_sources})
	target_include_directories(${PROJECT_NAME} PRIVATE ${C74_INCLUDES})
	include(${C74_MIN_API_DIR}/script/min-posttarget.cmake)

	unset(maxforge_external_sources)
endmacro()
