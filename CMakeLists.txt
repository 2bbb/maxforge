cmake_minimum_required(VERSION 3.19)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" maxforge_package_json)
string(
	JSON maxforge_version
	ERROR_VARIABLE maxforge_version_error
	GET "${maxforge_package_json}" version
)
if(maxforge_version_error)
	message(FATAL_ERROR "Could not read version from package.json: ${maxforge_version_error}")
endif()

project(maxforge VERSION "${maxforge_version}")

set(PACKAGE_VERSION "${PROJECT_VERSION}")
set(AUTHOR_DOMAIN "jp.2bit")
set(COPYRIGHT_STRING "Copyright (c) 2026 2bit")
set(EXCLUDE_FROM_COLLECTIVES "no")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/maxforge_external.cmake)

set(C74_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/externals)

if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
	set(CMAKE_OSX_ARCHITECTURES "x86_64;arm64" CACHE STRING "macOS architecture" FORCE)
endif()

set(maxforge_ixwebsocket_directory
	"${CMAKE_CURRENT_SOURCE_DIR}/deps/bbb.agent/deps/IXWebSocket"
)
if(NOT EXISTS "${maxforge_ixwebsocket_directory}/CMakeLists.txt")
	message(FATAL_ERROR
		"bbb.agent/IXWebSocket is missing. Run: git submodule update --init --recursive"
	)
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
if(WIN32)
	set(
		CMAKE_MSVC_RUNTIME_LIBRARY
		"MultiThreaded$<$<CONFIG:Debug>:Debug>"
		CACHE STRING ""
		FORCE
	)
endif()
add_subdirectory(
	"${maxforge_ixwebsocket_directory}"
	"${CMAKE_CURRENT_BINARY_DIR}/dependencies/IXWebSocket"
)

file(GLOB project_directories
	RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}/source/projects
	${CMAKE_CURRENT_SOURCE_DIR}/source/projects/*
)

foreach(project_directory ${project_directories})
	if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/source/projects/${project_directory}/CMakeLists.txt")
		message(STATUS "Generating Max external: ${project_directory}")
		add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/source/projects/${project_directory})
	endif()
endforeach()

set(CMAKE_SUPPRESS_REGENERATION true)
