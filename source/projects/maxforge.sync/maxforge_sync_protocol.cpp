#include "maxforge_sync_protocol.hpp"

#include <cctype>
#include <stdexcept>

namespace maxforge::sync_protocol {

namespace {

auto is_word_character(char character) -> bool {
	const auto unsigned_character = static_cast<unsigned char>(character);
	return std::isalnum(unsigned_character) != 0 || character == '_';
}

void remove_virtual_descendants(
	virtual_patch &state,
	const std::string &parent_path
) {
	std::vector<std::string> paths_to_remove;
	for(const auto &[path, boxes] : state) {
		(void)boxes;
		if(path == parent_path || path.rfind(parent_path + "/", 0) == 0) {
			paths_to_remove.push_back(path);
		}
	}
	for(const auto &path : paths_to_remove) state.erase(path);
}

void require_virtual_box(
	const virtual_patch &state,
	const std::vector<std::string> &path,
	const std::string &variable_name
) {
	const auto patcher = state.find(path_key(path));
	if(patcher == state.end()) {
		throw std::runtime_error(
			"target patcher does not exist: " + path_key(path)
		);
	}
	if(patcher->second.count(variable_name) == 0) {
		throw std::runtime_error("managed box does not exist: " + variable_name);
	}
}

}

auto is_valid_scope(const std::string &scope) -> bool {
	if(scope.empty()) return false;
	const auto first = static_cast<unsigned char>(scope.front());
	if(std::isalpha(first) == 0 && scope.front() != '_') return false;

	for(std::size_t index{1}; index < scope.size(); index++) {
		if(!is_word_character(scope[index])) return false;
	}
	return true;
}

auto is_valid_patcher_id(const std::string &patcher_id) -> bool {
	if(patcher_id.empty()) return false;
	const auto first = static_cast<unsigned char>(patcher_id.front());
	if(std::isalpha(first) == 0 && patcher_id.front() != '_') return false;

	for(std::size_t index{1}; index < patcher_id.size(); index++) {
		const auto character = patcher_id[index];
		if(!is_word_character(character) && character != '-') return false;
	}
	return true;
}

auto is_valid_box_id(const std::string &id) -> bool {
	constexpr auto prefix = "obj-";
	if(id.rfind(prefix, 0) != 0 || id.size() == 4) return false;

	for(std::size_t index{4}; index < id.size(); index++) {
		if(!is_word_character(id[index])) return false;
	}
	return true;
}

auto expected_variable_name(
	const std::string &scope,
	const std::string &id
) -> std::string
{
	return "maxforge_" + scope + "_obj_" + id.substr(4);
}

auto managed_id_from_variable_name(
	const std::string &scope,
	const std::string &variable_name
) -> std::string
{
	const auto prefix = "maxforge_" + scope + "_obj_";
	if(variable_name.rfind(prefix, 0) != 0 || variable_name.size() == prefix.size()) {
		return {};
	}

	const auto name = variable_name.substr(prefix.size());
	for(const auto character : name) {
		if(!is_word_character(character)) return {};
	}
	return "obj-" + name;
}

auto is_revision(const std::string &revision) -> bool {
	if(revision.size() != 64) return false;
	for(const auto character : revision) {
		if(
			!('0' <= character && character <= '9') &&
			!('a' <= character && character <= 'f')
		) {
			return false;
		}
	}
	return true;
}

auto path_key(const std::vector<std::string> &path) -> std::string {
	std::string key;
	for(const auto &component : path) {
		if(!key.empty()) key += "/";
		key += component;
	}
	return key;
}

auto child_path_key(
	const std::vector<std::string> &path,
	const std::string &variable_name
) -> std::string
{
	auto key = path_key(path);
	if(!key.empty()) key += "/";
	key += variable_name;
	return key;
}

void validate_identity(
	const std::string &scope,
	const std::string &id,
	const std::string &variable_name
) {
	if(!is_valid_box_id(id)) {
		throw std::runtime_error("invalid managed box id: " + id);
	}
	if(variable_name != expected_variable_name(scope, id)) {
		throw std::runtime_error("managed box identity mismatch: " + variable_name);
	}
}

auto text_creates_subpatcher(
	const std::string &max_class,
	const std::string &text
) -> bool
{
	if(max_class != "newobj") return false;
	return text == "p" ||
		text.rfind("p ", 0) == 0 ||
		text == "patcher" ||
		text.rfind("patcher ", 0) == 0;
}

auto operation_phase(operation_kind kind) -> long {
	switch(kind) {
		case operation_kind::disconnect: return 0;
		case operation_kind::delete_box: return 1;
		case operation_kind::create: return 2;
		case operation_kind::set: return 3;
		case operation_kind::connect: return 4;
	}
	return 5;
}

auto validate_plan(
	const validation_plan &plan,
	virtual_patch state,
	const std::string &configured_scope,
	const std::string &current_revision
) -> virtual_patch
{
	if(plan.scope != configured_scope) {
		throw std::runtime_error(
			"plan scope \"" + plan.scope +
			"\" does not match @scope \"" + configured_scope + "\""
		);
	}

	if(current_revision.empty()) {
		if(!state[""].empty()) {
			throw std::runtime_error(
				"revision state is empty but managed boxes already exist"
			);
		}
	} else if(plan.base_revision != current_revision) {
		throw std::runtime_error("base revision does not match current revision");
	}

	long previous_phase{};
	bool is_first{true};
	for(const auto &operation : plan.operations) {
		const auto phase = operation_phase(operation.kind);
		if(!is_first && phase < previous_phase) {
			throw std::runtime_error("patch operations are out of protocol order");
		}
		is_first = false;
		previous_phase = phase;

		const auto target_key = path_key(operation.target_path);
		const auto patcher = state.find(target_key);
		if(patcher == state.end()) {
			throw std::runtime_error(
				"target patcher does not exist: " + target_key
			);
		}

		switch(operation.kind) {
			case operation_kind::disconnect:
			case operation_kind::connect:
				require_virtual_box(
					state,
					operation.target_path,
					operation.source_variable_name
				);
				require_virtual_box(
					state,
					operation.target_path,
					operation.destination_variable_name
				);
				break;
			case operation_kind::delete_box: {
				require_virtual_box(
					state,
					operation.target_path,
					operation.variable_name
				);
				state[target_key].erase(operation.variable_name);
				remove_virtual_descendants(
					state,
					child_path_key(
						operation.target_path,
						operation.variable_name
					)
				);
				break;
			}
			case operation_kind::create: {
				if(patcher->second.count(operation.created_variable_name) != 0) {
					throw std::runtime_error(
						"managed box already exists: " +
						operation.created_variable_name
					);
				}
				state[target_key].insert(operation.created_variable_name);
				if(operation.creates_subpatcher) {
					state[child_path_key(
						operation.target_path,
						operation.created_variable_name
					)];
				}
				break;
			}
			case operation_kind::set:
				require_virtual_box(
					state,
					operation.target_path,
					operation.variable_name
				);
				break;
		}
	}
	return state;
}

}
