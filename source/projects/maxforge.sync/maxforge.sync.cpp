#include "c74_min.h"

#include <array>
#include <cctype>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

constexpr long protocol_version{1};

enum class operation_kind {
	disconnect,
	delete_box,
	create,
	set,
	connect
};

struct endpoint {
	std::string id;
	std::string variable_name;
	long port{};
};

struct box_definition {
	std::string id;
	std::string variable_name;
	std::string max_class;
	long inlet_count{};
	long outlet_count{};
	std::vector<std::string> outlet_types;
	std::array<double, 4> patching_rectangle{};
	bool has_text{};
	std::string text;
	bool has_comment{};
	std::string comment;
	c74::max::t_dictionary *attributes{};
	bool creates_subpatcher{};
};

struct patch_operation {
	operation_kind kind{};
	std::vector<std::string> target_path;
	endpoint source;
	endpoint destination;
	std::string id;
	std::string variable_name;
	std::string attribute;
	std::array<double, 4> value{};
	box_definition box;
};

struct patch_plan {
	std::string scope;
	std::string base_revision;
	std::string target_revision;
	std::vector<patch_operation> operations;
};

using virtual_patcher = std::unordered_set<std::string>;
using virtual_patch = std::unordered_map<std::string, virtual_patcher>;

auto is_word_character(char character) -> bool {
	const auto unsigned_character = static_cast<unsigned char>(character);
	return std::isalnum(unsigned_character) != 0 || character == '_';
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

auto dictionary_string(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> std::string
{
	const char *value{};
	const auto error = c74::max::dictionary_getstring(
		dictionary,
		c74::max::gensym(key),
		&value
	);
	if(error != c74::max::MAX_ERR_NONE || !value) {
		throw std::runtime_error(std::string{"missing or invalid string: "} + key);
	}
	return value;
}

auto dictionary_optional_string(
	const c74::max::t_dictionary *dictionary,
	const char *key,
	std::string &value
) -> bool
{
	if(!c74::max::dictionary_hasentry(dictionary, c74::max::gensym(key))) {
		return false;
	}
	value = dictionary_string(dictionary, key);
	return true;
}

auto dictionary_long(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> long
{
	c74::max::t_atom_long value{};
	const auto error = c74::max::dictionary_getlong(
		dictionary,
		c74::max::gensym(key),
		&value
	);
	if(error != c74::max::MAX_ERR_NONE) {
		throw std::runtime_error(std::string{"missing or invalid integer: "} + key);
	}
	return static_cast<long>(value);
}

auto dictionary_child(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> c74::max::t_dictionary *
{
	c74::max::t_object *value{};
	const auto error = c74::max::dictionary_getdictionary(
		dictionary,
		c74::max::gensym(key),
		&value
	);
	if(error != c74::max::MAX_ERR_NONE || !value) {
		throw std::runtime_error(std::string{"missing or invalid object: "} + key);
	}
	return reinterpret_cast<c74::max::t_dictionary *>(value);
}

auto dictionary_array(
	const c74::max::t_dictionary *dictionary,
	const char *key,
	long &count
) -> c74::max::t_atom *
{
	c74::max::t_object *value{};
	const auto dictionary_error = c74::max::dictionary_getatomarray(
		dictionary,
		c74::max::gensym(key),
		&value
	);
	if(dictionary_error != c74::max::MAX_ERR_NONE || !value) {
		throw std::runtime_error(std::string{"missing or invalid array: "} + key);
	}

	c74::max::t_atom *atoms{};
	const auto array_error = c74::max::atomarray_getatoms(
		reinterpret_cast<c74::max::t_atomarray *>(value),
		&count,
		&atoms
	);
	if(array_error != c74::max::MAX_ERR_NONE) {
		throw std::runtime_error(std::string{"could not read array: "} + key);
	}
	return atoms;
}

auto atom_string(const c74::max::t_atom &atom) -> std::string {
	if(c74::max::atom_gettype(&atom) == c74::max::A_SYM) {
		const auto *symbol = c74::max::atom_getsym(&atom);
		return symbol ? symbol->s_name : "";
	}
	if(c74::max::atomisstring(&atom)) {
		auto *string_object = reinterpret_cast<c74::max::t_string *>(
			c74::max::atom_getobj(&atom)
		);
		const auto *value = c74::max::string_getptr(string_object);
		return value ? value : "";
	}
	throw std::runtime_error("array entry is not a string");
}

auto atom_dictionary(const c74::max::t_atom &atom) -> c74::max::t_dictionary * {
	auto mutable_atom = atom;
	if(!c74::max::atomisdictionary(&mutable_atom)) {
		throw std::runtime_error("array entry is not an object");
	}
	return reinterpret_cast<c74::max::t_dictionary *>(
		c74::max::atom_getobj(&mutable_atom)
	);
}

auto string_array(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> std::vector<std::string>
{
	long count{};
	const auto *atoms = dictionary_array(dictionary, key, count);
	std::vector<std::string> values;
	values.reserve(static_cast<std::size_t>(count));
	for(long index{}; index < count; index++) {
		values.push_back(atom_string(atoms[index]));
	}
	return values;
}

auto rectangle_array(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> std::array<double, 4>
{
	long count{};
	const auto *atoms = dictionary_array(dictionary, key, count);
	if(count != 4) {
		throw std::runtime_error(std::string{key} + " must contain four numbers");
	}

	std::array<double, 4> values{};
	for(long index{}; index < count; index++) {
		const auto type = c74::max::atom_gettype(atoms + index);
		if(type != c74::max::A_LONG && type != c74::max::A_FLOAT) {
			throw std::runtime_error(std::string{key} + " must contain only numbers");
		}
		values[static_cast<std::size_t>(index)] = c74::max::atom_getfloat(atoms + index);
	}
	return values;
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

auto parse_endpoint(
	const c74::max::t_dictionary *dictionary,
	const std::string &scope
) -> endpoint
{
	endpoint result{
		dictionary_string(dictionary, "id"),
		dictionary_string(dictionary, "varName"),
		dictionary_long(dictionary, "port")
	};
	validate_identity(scope, result.id, result.variable_name);
	if(result.port < 0) throw std::runtime_error("endpoint port must not be negative");
	return result;
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

void validate_attribute_dictionary(const c74::max::t_dictionary *attributes) {
	constexpr std::array<const char *, 5> reserved_keys{
		"maxclass",
		"varname",
		"patching_rect",
		"text",
		"comment"
	};
	for(const auto *key : reserved_keys) {
		if(c74::max::dictionary_hasentry(attributes, c74::max::gensym(key))) {
			throw std::runtime_error(std::string{"reserved create attribute: "} + key);
		}
	}
}

auto parse_box_definition(
	c74::max::t_dictionary *dictionary,
	const std::string &scope
) -> box_definition
{
	box_definition result;
	result.id = dictionary_string(dictionary, "id");
	result.variable_name = dictionary_string(dictionary, "varName");
	result.max_class = dictionary_string(dictionary, "maxclass");
	result.inlet_count = dictionary_long(dictionary, "numinlets");
	result.outlet_count = dictionary_long(dictionary, "numoutlets");
	result.outlet_types = string_array(dictionary, "outlettype");
	result.patching_rectangle = rectangle_array(dictionary, "patchingRect");
	result.has_text = dictionary_optional_string(dictionary, "text", result.text);
	result.has_comment = dictionary_optional_string(dictionary, "comment", result.comment);
	result.attributes = dictionary_child(dictionary, "attributes");

	validate_identity(scope, result.id, result.variable_name);
	if(result.max_class.empty()) throw std::runtime_error("maxclass must not be empty");
	if(result.inlet_count < 0 || result.outlet_count < 0) {
		throw std::runtime_error("inlet and outlet counts must not be negative");
	}
	if(result.max_class == "newobj" && (!result.has_text || result.text.empty())) {
		throw std::runtime_error("newobj requires non-empty text");
	}
	validate_attribute_dictionary(result.attributes);
	result.creates_subpatcher = result.has_text &&
		text_creates_subpatcher(result.max_class, result.text);
	return result;
}

auto parse_operation(
	c74::max::t_dictionary *dictionary,
	const std::string &scope
) -> patch_operation
{
	patch_operation result;
	const auto operation_name = dictionary_string(dictionary, "op");
	result.target_path = string_array(dictionary, "targetPath");
	for(const auto &component : result.target_path) {
		const auto id = managed_id_from_variable_name(scope, component);
		if(id.empty()) {
			throw std::runtime_error("targetPath is outside the managed scope: " + component);
		}
	}

	if(operation_name == "disconnect" || operation_name == "connect") {
		result.kind = operation_name == "disconnect"
			? operation_kind::disconnect
			: operation_kind::connect;
		result.source = parse_endpoint(dictionary_child(dictionary, "source"), scope);
		result.destination = parse_endpoint(
			dictionary_child(dictionary, "destination"),
			scope
		);
		return result;
	}

	if(operation_name == "delete") {
		result.kind = operation_kind::delete_box;
		result.id = dictionary_string(dictionary, "id");
		result.variable_name = dictionary_string(dictionary, "varName");
		validate_identity(scope, result.id, result.variable_name);
		return result;
	}

	if(operation_name == "create") {
		result.kind = operation_kind::create;
		result.box = parse_box_definition(dictionary_child(dictionary, "box"), scope);
		return result;
	}

	if(operation_name == "set") {
		result.kind = operation_kind::set;
		result.id = dictionary_string(dictionary, "id");
		result.variable_name = dictionary_string(dictionary, "varName");
		result.attribute = dictionary_string(dictionary, "attribute");
		result.value = rectangle_array(dictionary, "value");
		validate_identity(scope, result.id, result.variable_name);
		if(result.attribute != "patching_rect") {
			throw std::runtime_error("unsupported set attribute: " + result.attribute);
		}
		return result;
	}

	throw std::runtime_error("unsupported patch operation: " + operation_name);
}

auto parse_plan(c74::max::t_dictionary *dictionary) -> patch_plan {
	if(dictionary_long(dictionary, "protocolVersion") != protocol_version) {
		throw std::runtime_error("unsupported patch protocol version");
	}

	patch_plan result;
	result.scope = dictionary_string(dictionary, "scope");
	result.base_revision = dictionary_string(dictionary, "baseRevision");
	result.target_revision = dictionary_string(dictionary, "targetRevision");
	if(!is_valid_scope(result.scope)) throw std::runtime_error("invalid plan scope");
	if(!is_revision(result.base_revision)) {
		throw std::runtime_error("invalid base revision");
	}
	if(!is_revision(result.target_revision)) {
		throw std::runtime_error("invalid target revision");
	}

	long operation_count{};
	const auto *operation_atoms = dictionary_array(
		dictionary,
		"operations",
		operation_count
	);
	result.operations.reserve(static_cast<std::size_t>(operation_count));
	for(long index{}; index < operation_count; index++) {
		result.operations.push_back(parse_operation(
			atom_dictionary(operation_atoms[index]),
			result.scope
		));
	}
	return result;
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

auto child_patcher(c74::max::t_object *box) -> c74::max::t_object * {
	if(!box) return nullptr;
	auto *object = c74::max::jbox_get_object(box);
	if(!object) return nullptr;
	long index{};
	return reinterpret_cast<c74::max::t_object *>(
		c74::max::object_subpatcher(object, &index, nullptr)
	);
}

auto find_named_box(
	c74::max::t_object *patcher,
	const std::string &variable_name
) -> c74::max::t_object *
{
	return reinterpret_cast<c74::max::t_object *>(
		c74::max::object_method(
			patcher,
			c74::max::gensym("getnamedbox"),
			c74::max::gensym(variable_name.c_str())
		)
	);
}

void seed_virtual_patch(
	c74::max::t_object *patcher,
	const std::string &scope,
	const std::vector<std::string> &path,
	virtual_patch &state
) {
	const auto current_path = path_key(path);
	state[current_path];
	for(
		auto *box = c74::max::jpatcher_get_firstobject(patcher);
		box;
		box = c74::max::jbox_get_nextobject(box)
	) {
		const auto *variable_symbol = c74::max::jbox_get_varname(box);
		if(!variable_symbol) continue;
		const std::string variable_name{variable_symbol->s_name};
		if(managed_id_from_variable_name(scope, variable_name).empty()) continue;

		state[current_path].insert(variable_name);
		auto *nested_patcher = child_patcher(box);
		if(nested_patcher) {
			auto nested_path = path;
			nested_path.push_back(variable_name);
			seed_virtual_patch(nested_patcher, scope, nested_path, state);
		}
	}
}

void remove_virtual_descendants(
	virtual_patch &state,
	const std::string &parent_path
) {
	std::vector<std::string> paths_to_remove;
	for(const auto &[path, _boxes] : state) {
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
		throw std::runtime_error("target patcher does not exist: " + path_key(path));
	}
	if(patcher->second.count(variable_name) == 0) {
		throw std::runtime_error("managed box does not exist: " + variable_name);
	}
}

void validate_plan_against_patch(
	const patch_plan &plan,
	c74::max::t_object *root_patcher,
	const std::string &configured_scope,
	const std::string &current_revision
) {
	if(plan.scope != configured_scope) {
		throw std::runtime_error(
			"plan scope \"" + plan.scope +
			"\" does not match @scope \"" + configured_scope + "\""
		);
	}

	virtual_patch state;
	seed_virtual_patch(root_patcher, plan.scope, {}, state);
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
			throw std::runtime_error("target patcher does not exist: " + target_key);
		}

		switch(operation.kind) {
			case operation_kind::disconnect:
			case operation_kind::connect:
				require_virtual_box(
					state,
					operation.target_path,
					operation.source.variable_name
				);
				require_virtual_box(
					state,
					operation.target_path,
					operation.destination.variable_name
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
					child_path_key(operation.target_path, operation.variable_name)
				);
				break;
			}
			case operation_kind::create: {
				if(patcher->second.count(operation.box.variable_name) != 0) {
					throw std::runtime_error(
						"managed box already exists: " + operation.box.variable_name
					);
				}
				state[target_key].insert(operation.box.variable_name);
				if(operation.box.creates_subpatcher) {
					state[child_path_key(
						operation.target_path,
						operation.box.variable_name
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
}

auto resolve_target_patcher(
	c74::max::t_object *root_patcher,
	const std::vector<std::string> &target_path
) -> c74::max::t_object *
{
	auto *patcher = root_patcher;
	for(const auto &component : target_path) {
		auto *box = find_named_box(patcher, component);
		if(!box) return nullptr;
		patcher = child_patcher(box);
		if(!patcher) return nullptr;
	}
	return patcher;
}

auto apply_connection(
	c74::max::t_object *patcher,
	const patch_operation &operation,
	const char *method_name
) -> bool
{
	auto *source = find_named_box(patcher, operation.source.variable_name);
	auto *destination = find_named_box(patcher, operation.destination.variable_name);
	if(!source || !destination) return false;

	std::array<c74::max::t_atom, 4> arguments{};
	c74::max::atom_setobj(arguments.data(), source);
	c74::max::atom_setlong(arguments.data() + 1, operation.source.port);
	c74::max::atom_setobj(arguments.data() + 2, destination);
	c74::max::atom_setlong(arguments.data() + 3, operation.destination.port);
	c74::max::t_atom result{};
	return c74::max::object_method_typed(
		patcher,
		c74::max::gensym(method_name),
		static_cast<long>(arguments.size()),
		arguments.data(),
		&result
	) == c74::max::MAX_ERR_NONE;
}

auto apply_create(
	c74::max::t_object *patcher,
	const box_definition &box
) -> bool
{
	auto *specification = c74::max::dictionary_clone(box.attributes);
	if(!specification) return false;

	c74::max::dictionary_appendsym(
		specification,
		c74::max::gensym("maxclass"),
		c74::max::gensym(box.max_class.c_str())
	);
	c74::max::dictionary_appendsym(
		specification,
		c74::max::gensym("varname"),
		c74::max::gensym(box.variable_name.c_str())
	);

	std::array<c74::max::t_atom, 4> rectangle_atoms{};
	for(std::size_t index{}; index < rectangle_atoms.size(); index++) {
		c74::max::atom_setfloat(
			rectangle_atoms.data() + index,
			box.patching_rectangle[index]
		);
	}
	c74::max::dictionary_appendatoms(
		specification,
		c74::max::gensym("patching_rect"),
		static_cast<long>(rectangle_atoms.size()),
		rectangle_atoms.data()
	);
	if(box.has_text) {
		c74::max::dictionary_appendstring(
			specification,
			c74::max::gensym("text"),
			box.text.c_str()
		);
	}
	if(box.has_comment) {
		c74::max::dictionary_appendstring(
			specification,
			c74::max::gensym("comment"),
			box.comment.c_str()
		);
	}

	auto *created_box = c74::max::newobject_fromdictionary(patcher, specification);
	c74::max::object_free(specification);
	return created_box != nullptr;
}

auto apply_set(
	c74::max::t_object *patcher,
	const patch_operation &operation
) -> bool
{
	auto *box = find_named_box(patcher, operation.variable_name);
	if(!box) return false;

	std::array<c74::max::t_atom, 4> value_atoms{};
	for(std::size_t index{}; index < value_atoms.size(); index++) {
		c74::max::atom_setfloat(value_atoms.data() + index, operation.value[index]);
	}
	return c74::max::object_attr_setvalueof(
		box,
		c74::max::gensym(operation.attribute.c_str()),
		static_cast<long>(value_atoms.size()),
		value_atoms.data()
	) == c74::max::MAX_ERR_NONE;
}

auto apply_operation(
	c74::max::t_object *root_patcher,
	const patch_operation &operation
) -> bool
{
	auto *target_patcher = resolve_target_patcher(root_patcher, operation.target_path);
	if(!target_patcher) return false;

	switch(operation.kind) {
		case operation_kind::disconnect:
			return apply_connection(target_patcher, operation, "disconnect");
		case operation_kind::delete_box: {
			auto *box = find_named_box(target_patcher, operation.variable_name);
			if(!box) return false;
			c74::max::object_free(box);
			return true;
		}
		case operation_kind::create:
			return apply_create(target_patcher, operation.box);
		case operation_kind::set:
			return apply_set(target_patcher, operation);
		case operation_kind::connect:
			return apply_connection(target_patcher, operation, "connect");
	}
	return false;
}

auto dictionary_from_atoms(
	const c74::min::atoms &arguments
) -> c74::max::t_dictionary *
{
	if(arguments.empty()) throw std::runtime_error("apply requires a JSON plan");

	c74::max::t_dictionary *dictionary{};
	if(
		arguments.size() == 1 &&
		c74::max::atom_gettype(&arguments.front()) == c74::max::A_SYM
	) {
		const std::string json = arguments.front();
		std::array<char, 256> error_message{};
		const auto error = c74::max::dictobj_dictionaryfromstring(
			&dictionary,
			json.c_str(),
			1,
			error_message.data()
		);
		if(error != c74::max::MAX_ERR_NONE || !dictionary) {
			throw std::runtime_error(
				error_message.front() ? error_message.data() : "invalid JSON plan"
			);
		}
		return dictionary;
	}

	const auto error = c74::max::dictobj_dictionaryfromatoms_extended(
		&dictionary,
		c74::max::gensym(""),
		static_cast<long>(arguments.size()),
		reinterpret_cast<const c74::max::t_atom *>(arguments.data())
	);
	if(error != c74::max::MAX_ERR_NONE || !dictionary) {
		throw std::runtime_error("invalid JSON plan");
	}
	return dictionary;
}

} // namespace

class maxforge_sync : public c74::min::object<maxforge_sync> {
public:
	MIN_DESCRIPTION{"Validate and apply maxforge PatchPlan operations"};
	MIN_TAGS{"patcher, scripting, agent"};
	MIN_AUTHOR{"2bit"};

	c74::min::inlet<> input{this, "(anything) apply, applydict, validate, revision"};
	c74::min::outlet<> status_output{this, "(anything) status and errors"};

	c74::min::attribute<c74::min::symbol> scope{
		this,
		"scope",
		"default",
		c74::min::description{"Managed maxforge scope"}
	};

	c74::min::attribute<c74::min::symbol> revision_state{
		this,
		"revision_state",
		"",
		c74::min::description{"Persisted optimistic concurrency revision"}
	};

	c74::min::message<> apply_message{
		this,
		"apply",
		"Validate and apply a compact JSON PatchPlan",
		MIN_FUNCTION {
			process_atoms(args, true);
			return {};
		}
	};

	c74::min::message<> validate_message{
		this,
		"validate",
		"Validate a compact JSON PatchPlan without mutating the patcher",
		MIN_FUNCTION {
			process_atoms(args, false);
			return {};
		}
	};

	c74::min::message<> apply_dictionary_message{
		this,
		"applydict",
		"Validate and apply a named Max dictionary",
		MIN_FUNCTION {
			if(args.size() != 1) {
				send_error("applydict requires one dictionary name");
				return {};
			}
			const c74::min::symbol dictionary_name = args.front();
			auto *dictionary = c74::max::dictobj_findregistered_clone(dictionary_name);
			if(!dictionary) {
				send_error("dictionary not found: " + std::string{dictionary_name.c_str()});
				return {};
			}
			process_dictionary(dictionary, true);
			c74::max::object_free(dictionary);
			return {};
		}
	};

	c74::min::message<> revision_message{
		this,
		"revision",
		"Output the current managed revision",
		MIN_FUNCTION {
			const c74::min::symbol revision = revision_state;
			status_output.send(
				"revision",
				revision.c_str()[0] == '\0' ? "uninitialized" : revision
			);
			return {};
		}
	};

private:
	void process_atoms(const c74::min::atoms &arguments, bool should_apply) {
		c74::max::t_dictionary *dictionary{};
		try {
			dictionary = dictionary_from_atoms(arguments);
			process_dictionary(dictionary, should_apply);
			c74::max::object_free(dictionary);
		} catch(const std::exception &exception) {
			if(dictionary) c74::max::object_free(dictionary);
			send_error(exception.what());
		} catch(...) {
			if(dictionary) c74::max::object_free(dictionary);
			send_error("unknown plan processing error");
		}
	}

	void process_dictionary(
		c74::max::t_dictionary *dictionary,
		bool should_apply
	) {
		try {
			const auto plan = parse_plan(dictionary);
			c74::max::t_object *root_patcher{};
			const auto patcher_error = c74::max::object_obex_lookup(
				maxobj(),
				c74::max::gensym("#P"),
				&root_patcher
			);
			if(patcher_error != c74::max::MAX_ERR_NONE || !root_patcher) {
				throw std::runtime_error("could not access the containing patcher");
			}

			const c74::min::symbol configured_scope_symbol = scope;
			const std::string configured_scope{configured_scope_symbol.c_str()};
			if(!is_valid_scope(configured_scope)) {
				throw std::runtime_error("invalid @scope: " + configured_scope);
			}
			const c74::min::symbol revision_symbol = revision_state;
			const std::string current_revision{revision_symbol.c_str()};
			validate_plan_against_patch(
				plan,
				root_patcher,
				configured_scope,
				current_revision
			);

			if(!should_apply) {
				status_output.send(
					"validated",
					plan.target_revision,
					static_cast<long>(plan.operations.size())
				);
				return;
			}

			for(std::size_t index{}; index < plan.operations.size(); index++) {
				if(!apply_operation(root_patcher, plan.operations[index])) {
					throw std::runtime_error(
						"operation " + std::to_string(index) +
						" failed; the patch may be partially modified"
					);
				}
			}

			revision_state = c74::min::symbol{plan.target_revision};
			status_output.send(
				"applied",
				plan.target_revision,
				static_cast<long>(plan.operations.size())
			);
		} catch(const std::exception &exception) {
			send_error(exception.what());
		} catch(...) {
			send_error("unknown plan processing error");
		}
	}

	void send_error(const std::string &message) {
		status_output.send("error", message);
	}
};

MIN_EXTERNAL(maxforge_sync);
