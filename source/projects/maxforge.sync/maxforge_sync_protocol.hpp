#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace maxforge::sync_protocol {

constexpr long protocol_version{1};

enum class operation_kind {
	disconnect,
	delete_box,
	create,
	set,
	connect
};

enum class edit_observation_cause {
	patcher,
	box,
	line,
	attribute,
	unknown
};

struct validation_operation {
	operation_kind kind{};
	std::vector<std::string> target_path;
	std::string source_variable_name;
	std::string destination_variable_name;
	std::string variable_name;
	std::string created_variable_name;
	bool creates_subpatcher{};
};

struct validation_plan {
	std::string scope;
	std::string base_revision;
	std::vector<validation_operation> operations;
};

using virtual_patcher = std::unordered_set<std::string>;
using virtual_patch = std::unordered_map<std::string, virtual_patcher>;

auto is_valid_scope(const std::string &scope) -> bool;
auto edit_observation_cause_from_registration(
	const std::string &registration,
	const std::string &notification
) -> edit_observation_cause;
auto edit_observation_cause_name(edit_observation_cause cause) -> const char *;
auto is_valid_patcher_id(const std::string &patcher_id) -> bool;
auto is_valid_box_id(const std::string &id) -> bool;
auto is_loopback_host(const std::string &host) -> bool;
auto is_valid_network_host(const std::string &host) -> bool;
auto is_valid_auth_token(const std::string &token) -> bool;
auto has_maxpat_extension(const std::string &path) -> bool;
auto is_safe_set_attribute(const std::string &attribute) -> bool;
auto expected_variable_name(
	const std::string &scope,
	const std::string &id
) -> std::string;
auto managed_id_from_variable_name(
	const std::string &scope,
	const std::string &variable_name
) -> std::string;
auto is_revision(const std::string &revision) -> bool;
auto is_structure_token(const std::string &token) -> bool;
auto structure_token(const std::string &canonical_structure) -> std::string;
void validate_structure_token(
	const std::string &expected_token,
	const std::string &canonical_structure
);
auto path_key(const std::vector<std::string> &path) -> std::string;
auto child_path_key(
	const std::vector<std::string> &path,
	const std::string &variable_name
) -> std::string;
void validate_identity(
	const std::string &scope,
	const std::string &id,
	const std::string &variable_name
);
auto text_creates_subpatcher(
	const std::string &max_class,
	const std::string &text
) -> bool;
auto operation_phase(operation_kind kind) -> long;
auto validate_plan(
	const validation_plan &plan,
	virtual_patch state,
	const std::string &configured_scope,
	const std::string &current_revision
) -> virtual_patch;

}
