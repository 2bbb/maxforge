#include "c74_min.h"
#include "bbb_agent_websocket_client.hpp"
#include "maxforge_sync_protocol.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

#ifndef MAXFORGE_PACKAGE_VERSION
#define MAXFORGE_PACKAGE_VERSION "unknown"
#endif

namespace {

namespace sync_protocol = maxforge::sync_protocol;
using operation_kind = sync_protocol::operation_kind;

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
	std::vector<c74::max::t_atom> value;
	box_definition box;
};

struct patch_plan {
	std::string scope;
	std::string base_revision;
	std::string target_revision;
	bool has_base_structure_token{};
	std::string base_structure_token;
	std::vector<patch_operation> operations;
	bool has_rollback_operations{};
	std::vector<patch_operation> rollback_operations;
};

struct snapshot_box {
	std::vector<std::string> target_path;
	std::string runtime_id;
	std::string variable_name;
	std::string max_class;
	std::array<double, 4> patching_rectangle{};
	bool managed{};
	bool has_text{};
	std::string text;
	bool has_comment{};
	std::string comment;
	std::vector<std::pair<std::string, std::string>> attributes;
};

struct snapshot_endpoint {
	std::string runtime_id;
	std::string variable_name;
	long port{};
};

struct snapshot_connection {
	std::vector<std::string> target_path;
	snapshot_endpoint source;
	snapshot_endpoint destination;
	std::vector<std::pair<std::string, std::string>> attributes;
};

struct patch_snapshot {
	std::string title;
	std::string filename;
	std::string filepath;
	bool dirty{};
	bool locked{};
	bool presentation{};
	std::vector<snapshot_box> boxes;
	std::vector<snapshot_connection> connections;
};

struct resolved_patch_path {
	short path_id{};
	std::array<char, c74::max::MAX_FILENAME_CHARS> filename{};
};

auto make_instance_id(const void *address) -> std::string {
	static std::atomic<std::uint64_t> sequence{};
	const auto timestamp = std::chrono::high_resolution_clock::now()
		.time_since_epoch().count();
	std::ostringstream result;
	result
		<< "instance_"
		<< std::hex
		<< timestamp
		<< "_"
		<< reinterpret_cast<std::uintptr_t>(address)
		<< "_"
		<< sequence.fetch_add(1);
	return result.str();
}

auto json_string(const std::string &value) -> std::string {
	constexpr char hexadecimal[]{"0123456789abcdef"};
	std::string result{"\""};
	for(const auto character : value) {
		const auto unsigned_character = static_cast<unsigned char>(character);
		switch(character) {
			case '"':
				result += "\\\"";
				break;
			case '\\':
				result += "\\\\";
				break;
			case '\b':
				result += "\\b";
				break;
			case '\f':
				result += "\\f";
				break;
			case '\n':
				result += "\\n";
				break;
			case '\r':
				result += "\\r";
				break;
			case '\t':
				result += "\\t";
				break;
			default:
				if(unsigned_character < 0x20) {
					result += "\\u00";
					result += hexadecimal[(unsigned_character >> 4) & 0x0f];
					result += hexadecimal[unsigned_character & 0x0f];
				} else {
					result += character;
				}
		}
	}
	result += '"';
	return result;
}

auto json_number(double value) -> std::string;

auto patch_box_json(
	const std::string &id,
	const std::string &max_class,
	const std::string &text,
	double x,
	double y,
	double width,
	double height
) -> std::string
{
	return
		"{\"box\":{\"id\":" + json_string(id) +
		",\"maxclass\":" + json_string(max_class) +
		",\"patching_rect\":[" +
		json_number(x) + "," +
		json_number(y) + "," +
		json_number(width) + "," +
		json_number(height) + "]" +
		(text.empty() ? "" : ",\"text\":" + json_string(text)) +
		"}}";
}

auto patcher_json(
	const std::vector<std::string> &boxes,
	const std::vector<std::string> &lines,
	double width,
	double height
) -> std::string
{
	std::string result{
		"{\"fileversion\":1,\"classnamespace\":\"box\",\"rect\":[120,120," +
		json_number(width) + "," +
		json_number(height) + "]," +
		"\"bglocked\":0,\"openinpresentation\":0," +
		"\"default_fontsize\":12,\"default_fontface\":0," +
		"\"default_fontname\":\"Arial\",\"gridonopen\":1," +
		"\"gridsize\":[15,15],\"gridsnaponopen\":1," +
		"\"objectsnaponopen\":1,\"toolbarvisible\":1,\"boxes\":["
	};
	for(std::size_t index{}; index < boxes.size(); index++) {
		if(0 < index) result += ",";
		result += boxes[index];
	}
	result += "],\"lines\":[";
	for(std::size_t index{}; index < lines.size(); index++) {
		if(0 < index) result += ",";
		result += lines[index];
	}
	result += "]}";
	return result;
}

auto bridge_patch_json(
	const std::string &patcher_id,
	const std::string &scope,
	const std::string &host,
	long port,
	const std::string &token
) -> std::string
{
	auto object_text =
		"maxforge.sync @host " + host +
		" @port " + std::to_string(port) +
		" @scope " + scope +
		" @patcher_id " + patcher_id +
		" @controller 0";
	if(!token.empty()) object_text += " @token " + token;
	const std::vector<std::string> boxes{
		patch_box_json("obj-sync", "newobj", object_text, 30, 30, 680, 22)
	};
	return "{\"patcher\":" +
		patcher_json(boxes, {}, 900, 560) +
		"}";
}

auto json_number(double value) -> std::string {
	if(!std::isfinite(value)) return "null";
	std::ostringstream stream;
	stream << std::setprecision(17) << value;
	return stream.str();
}

auto resolve_patch_path(const std::string &path) -> resolved_patch_path {
	if(path.empty() || c74::max::MAX_PATH_CHARS <= path.size()) {
		throw std::runtime_error("patch path is empty or exceeds Max's path limit");
	}
	if(!sync_protocol::has_maxpat_extension(path)) {
		throw std::runtime_error("patch path must end with .maxpat");
	}
	resolved_patch_path result;
	const auto error = c74::max::path_frompathname(
		path.c_str(),
		&result.path_id,
		result.filename.data()
	);
	if(error != 0 || result.filename.front() == '\0') {
		throw std::runtime_error("Max could not resolve patch path: " + path);
	}
	return result;
}

auto patch_path_exists(const resolved_patch_path &path) -> bool {
	c74::max::t_fileinfo information{};
	return c74::max::path_fileinfo(
		path.filename.data(),
		path.path_id,
		&information
	) == 0;
}

auto create_bridge_patch(
	const std::string &patcher_id,
	const std::string &scope,
	const std::string &title,
	const std::string &host,
	long port,
	const std::string &token
) -> c74::max::t_object *
{
	const auto json = bridge_patch_json(
		patcher_id,
		scope,
		host,
		port,
		token
	);
	std::string buffer_name{patcher_id + ".maxpat"};
	auto *patcher = reinterpret_cast<c74::max::t_object *>(
		c74::max::jpatcher_load_frombuffer(
			buffer_name.data(),
			0,
			json.c_str(),
			static_cast<long>(json.size()),
			0,
			nullptr
		)
	);
	if(!patcher) {
		throw std::runtime_error("Max could not create the top-level patch");
	}
	c74::max::jpatcher_set_title(
		patcher,
		c74::max::gensym(title.c_str())
	);
	c74::max::jpatcher_set_dirty(patcher, 1);
	c74::max::jpatcher_set_locked(patcher, 0);
	c74::max::object_method(
		patcher,
		c74::max::gensym("front")
	);
	c74::max::object_method(
		patcher,
		c74::max::gensym("loadbang")
	);
	return patcher;
}

auto json_string_array(const std::vector<std::string> &values) -> std::string {
	std::string result{"["};
	for(std::size_t index{}; index < values.size(); index++) {
		if(0 < index) result += ",";
		result += json_string(values[index]);
	}
	result += "]";
	return result;
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

auto patch_value_atoms(
	const c74::max::t_dictionary *dictionary,
	const char *key
) -> std::vector<c74::max::t_atom>
{
	long count{};
	c74::max::t_atom *atoms{};
	if(
		c74::max::dictionary_getatoms(
			dictionary,
			c74::max::gensym(key),
			&count,
			&atoms
		) != c74::max::MAX_ERR_NONE ||
		count <= 0 ||
		!atoms
	) {
		throw std::runtime_error(std::string{"missing or invalid value: "} + key);
	}
	if(count == 1 && c74::max::atomisatomarray(atoms)) {
		auto *array = reinterpret_cast<c74::max::t_atomarray *>(
			c74::max::atom_getobj(atoms)
		);
		if(
			!array ||
			c74::max::atomarray_getatoms(array, &count, &atoms) !=
				c74::max::MAX_ERR_NONE
		) {
			throw std::runtime_error("could not read set value array");
		}
	}
	if(count <= 0 || 256 < count) {
		throw std::runtime_error("set value must contain between 1 and 256 atoms");
	}

	std::vector<c74::max::t_atom> values;
	values.reserve(static_cast<std::size_t>(count));
	for(long index{}; index < count; index++) {
		const auto type = c74::max::atom_gettype(atoms + index);
		if(
			type != c74::max::A_LONG &&
			type != c74::max::A_FLOAT &&
			type != c74::max::A_SYM &&
			!c74::max::atomisstring(atoms + index)
		) {
			throw std::runtime_error("set values must contain only numbers or strings");
		}
		c74::max::t_atom value = atoms[index];
		if(c74::max::atomisstring(&value)) {
			c74::max::atom_setsym(
				&value,
				c74::max::gensym(atom_string(value).c_str())
			);
		}
		values.push_back(value);
	}
	return values;
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
	sync_protocol::validate_identity(scope, result.id, result.variable_name);
	if(result.port < 0) throw std::runtime_error("endpoint port must not be negative");
	return result;
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

	sync_protocol::validate_identity(scope, result.id, result.variable_name);
	if(result.max_class.empty()) throw std::runtime_error("maxclass must not be empty");
	if(result.inlet_count < 0 || result.outlet_count < 0) {
		throw std::runtime_error("inlet and outlet counts must not be negative");
	}
	if(result.max_class == "newobj" && (!result.has_text || result.text.empty())) {
		throw std::runtime_error("newobj requires non-empty text");
	}
	validate_attribute_dictionary(result.attributes);
	result.creates_subpatcher = result.has_text &&
		sync_protocol::text_creates_subpatcher(result.max_class, result.text);
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
		const auto id = sync_protocol::managed_id_from_variable_name(scope, component);
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
		sync_protocol::validate_identity(scope, result.id, result.variable_name);
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
		result.value = patch_value_atoms(dictionary, "value");
		sync_protocol::validate_identity(scope, result.id, result.variable_name);
		if(!sync_protocol::is_safe_set_attribute(result.attribute)) {
			throw std::runtime_error("unsafe set attribute: " + result.attribute);
		}
		if(result.attribute == "patching_rect") {
			if(result.value.size() != 4) {
				throw std::runtime_error("patching_rect requires four numbers");
			}
			for(const auto &value : result.value) {
				const auto type = c74::max::atom_gettype(&value);
				if(type != c74::max::A_LONG && type != c74::max::A_FLOAT) {
					throw std::runtime_error("patching_rect requires four numbers");
				}
			}
		}
		return result;
	}

	throw std::runtime_error("unsupported patch operation: " + operation_name);
}

auto parse_plan(c74::max::t_dictionary *dictionary) -> patch_plan {
	if(dictionary_long(dictionary, "protocolVersion") != sync_protocol::protocol_version) {
		throw std::runtime_error("unsupported patch protocol version");
	}

	patch_plan result;
	result.scope = dictionary_string(dictionary, "scope");
	result.base_revision = dictionary_string(dictionary, "baseRevision");
	result.target_revision = dictionary_string(dictionary, "targetRevision");
	result.has_base_structure_token = dictionary_optional_string(
		dictionary,
		"baseStructureToken",
		result.base_structure_token
	);
	if(!sync_protocol::is_valid_scope(result.scope)) throw std::runtime_error("invalid plan scope");
	if(!sync_protocol::is_revision(result.base_revision)) {
		throw std::runtime_error("invalid base revision");
	}
	if(!sync_protocol::is_revision(result.target_revision)) {
		throw std::runtime_error("invalid target revision");
	}
	if(
		result.has_base_structure_token &&
		!sync_protocol::is_structure_token(result.base_structure_token)
	) {
		throw std::runtime_error("invalid base structure token");
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
	result.has_rollback_operations = c74::max::dictionary_hasentry(
		dictionary,
		c74::max::gensym("rollbackOperations")
	) != 0;
	if(result.has_rollback_operations) {
		long rollback_count{};
		const auto *rollback_atoms = dictionary_array(
			dictionary,
			"rollbackOperations",
			rollback_count
		);
		result.rollback_operations.reserve(
			static_cast<std::size_t>(rollback_count)
		);
		for(long index{}; index < rollback_count; index++) {
			result.rollback_operations.push_back(parse_operation(
				atom_dictionary(rollback_atoms[index]),
				result.scope
			));
		}
	}
	return result;
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

auto symbol_string(const c74::max::t_symbol *symbol) -> std::string {
	return symbol && symbol->s_name ? symbol->s_name : "";
}

auto box_runtime_id(c74::max::t_object *box) -> std::string {
	const auto id = symbol_string(c74::max::jbox_get_id(box));
	if(!id.empty()) return id;

	std::ostringstream stream;
	stream << "box@" << box;
	return stream.str();
}

auto attribute_text(
	c74::max::t_object *object,
	const char *attribute_name,
	bool &has_text
) -> std::string
{
	has_text = false;
	if(!object) return {};
	const auto text_symbol = c74::max::gensym(attribute_name);
	if(!c74::max::object_attr_get(object, text_symbol)) return {};

	long count{};
	c74::max::t_atom *values{};
	const auto value_error = c74::max::object_attr_getvalueof(
		object,
		text_symbol,
		&count,
		&values
	);
	if(value_error != c74::max::MAX_ERR_NONE || count <= 0 || !values) {
		if(values) c74::max::sysmem_freeptr(values);
		return {};
	}

	long text_size{};
	char *text{};
	const auto text_error = c74::max::atom_gettext(
		count,
		values,
		&text_size,
		&text,
		c74::max::OBEX_UTIL_ATOM_GETTEXT_SYM_NO_QUOTE |
			c74::max::OBEX_UTIL_ATOM_GETTEXT_TRUNCATE_ZEROS
	);
	c74::max::sysmem_freeptr(values);
	if(text_error != c74::max::MAX_ERR_NONE || !text) {
		if(text) c74::max::sysmem_freeptr(text);
		return {};
	}

	const std::string result{text};
	c74::max::sysmem_freeptr(text);
	has_text = true;
	return result;
}

auto box_text(c74::max::t_object *box, bool &has_text) -> std::string {
	auto result = attribute_text(box, "text", has_text);
	if(has_text) return result;

	result = attribute_text(c74::max::jbox_get_object(box), "text", has_text);
	if(has_text) return result;

	auto *textfield = c74::max::jbox_get_textfield(box);
	result = attribute_text(textfield, "text", has_text);
	if(has_text) return result;

	if(!textfield) return {};
	// Max's patcher controller reads live textfields through this A_CANT method.
	// object_method_imp is required here; object_method returns the error sentinel.
	const auto text_symbol = c74::max::gensym("getptr");
	if(!c74::max::object_getmethod(textfield, text_symbol)) return {};
	const auto *text = (const char *)c74::max::object_method_imp(
		textfield,
		text_symbol,
		nullptr,
		nullptr,
		nullptr,
		nullptr,
		nullptr,
		nullptr,
		nullptr,
		nullptr
	);
	if(!text) return {};
	has_text = true;
	return text;
}

auto atoms_json(long count, const c74::max::t_atom *values) -> std::string {
	if(count <= 0 || 256 < count || !values) return {};
	std::vector<std::string> encoded;
	encoded.reserve(static_cast<std::size_t>(count));
	for(long index{}; index < count; index++) {
		const auto type = c74::max::atom_gettype(values + index);
		if(type == c74::max::A_LONG) {
			encoded.push_back(std::to_string(c74::max::atom_getlong(values + index)));
		} else if(type == c74::max::A_FLOAT) {
			const auto value = c74::max::atom_getfloat(values + index);
			if(!std::isfinite(value)) return {};
			encoded.push_back(json_number(value));
		} else if(type == c74::max::A_SYM || c74::max::atomisstring(values + index)) {
			encoded.push_back(json_string(atom_string(values[index])));
		} else {
			return {};
		}
	}
	if(encoded.size() == 1) return encoded.front();
	std::string result{"["};
	for(std::size_t index{}; index < encoded.size(); index++) {
		if(0 < index) result += ",";
		result += encoded[index];
	}
	return result + "]";
}

auto is_snapshot_attribute(const std::string &name) -> bool {
	static const std::unordered_set<std::string> separately_serialized{
		"patching_rect",
		"text",
		"comment",
		"value"
	};
	return sync_protocol::is_safe_set_attribute(name) &&
		separately_serialized.count(name) == 0;
}

void collect_snapshot_attributes(
	c74::max::t_object *object,
	std::vector<std::pair<std::string, std::string>> &attributes
) {
	if(!object) return;
	long count{};
	c74::max::t_symbol **names{};
	if(
		c74::max::object_attr_getnames(object, &count, &names) !=
			c74::max::MAX_ERR_NONE ||
		count <= 0 ||
		!names
	) {
		if(names) c74::max::sysmem_freeptr(names);
		return;
	}

	for(long index{}; index < count; index++) {
		auto *name = names[index];
		const auto attribute_name = symbol_string(name);
		if(
			!name ||
			!is_snapshot_attribute(attribute_name) ||
			c74::max::object_attr_usercanget(object, name) == 0 ||
			c74::max::object_attr_usercanset(object, name) == 0 ||
			c74::max::object_attr_getdirty(object, name) == 0
		) {
			continue;
		}

		long value_count{};
		c74::max::t_atom *values{};
		if(
			c74::max::object_attr_getvalueof(
				object,
				name,
				&value_count,
				&values
			) != c74::max::MAX_ERR_NONE
		) {
			if(values) c74::max::sysmem_freeptr(values);
			continue;
		}
		const auto encoded = atoms_json(value_count, values);
		if(values) c74::max::sysmem_freeptr(values);
		if(encoded.empty()) continue;

		auto existing = std::find_if(
			attributes.begin(),
			attributes.end(),
			[&attribute_name](const auto &attribute) {
				return attribute.first == attribute_name;
			}
		);
		if(existing == attributes.end()) {
			attributes.emplace_back(attribute_name, encoded);
		}
	}
	c74::max::sysmem_freeptr(names);
}

auto attributes_json(
	const std::vector<std::pair<std::string, std::string>> &attributes
) -> std::string
{
	std::string result{"{"};
	for(std::size_t index{}; index < attributes.size(); index++) {
		if(0 < index) result += ",";
		result += json_string(attributes[index].first) + ":" + attributes[index].second;
	}
	return result + "}";
}

auto snapshot_path_component(const snapshot_box &box) -> std::string {
	return box.variable_name.empty() ? box.runtime_id : box.variable_name;
}

auto snapshot_box_from_object(
	c74::max::t_object *box,
	const std::string &scope,
	const std::vector<std::string> &target_path
) -> snapshot_box
{
	snapshot_box result;
	result.target_path = target_path;
	result.runtime_id = box_runtime_id(box);
	result.variable_name = symbol_string(c74::max::jbox_get_varname(box));
	result.max_class = symbol_string(c74::max::jbox_get_maxclass(box));
	result.managed = !sync_protocol::managed_id_from_variable_name(
		scope,
		result.variable_name
	).empty();

	c74::max::t_rect rectangle{};
	if(
		c74::max::jbox_get_patching_rect(box, &rectangle) ==
		c74::max::MAX_ERR_NONE
	) {
		result.patching_rectangle = {
			rectangle.x,
			rectangle.y,
			rectangle.width,
			rectangle.height
		};
	}
	result.text = box_text(box, result.has_text);
	result.comment = attribute_text(box, "comment", result.has_comment);
	if(!result.has_comment) {
		result.comment = attribute_text(
			c74::max::jbox_get_object(box),
			"comment",
			result.has_comment
		);
	}
	collect_snapshot_attributes(box, result.attributes);
	collect_snapshot_attributes(c74::max::jbox_get_object(box), result.attributes);
	std::sort(result.attributes.begin(), result.attributes.end());
	return result;
}

auto snapshot_endpoint_from_box(
	c74::max::t_object *box,
	long port
) -> snapshot_endpoint
{
	if(!box) throw std::runtime_error("patch cord has a missing endpoint");
	return {
		box_runtime_id(box),
		symbol_string(c74::max::jbox_get_varname(box)),
		port
	};
}

void collect_patch_snapshot(
	c74::max::t_object *patcher,
	const std::string &scope,
	const std::vector<std::string> &target_path,
	std::unordered_set<c74::max::t_object *> &ancestors,
	patch_snapshot &snapshot
) {
	if(!patcher) return;
	if(ancestors.count(patcher) != 0) {
		throw std::runtime_error("cyclic subpatcher hierarchy detected");
	}
	if(32 <= target_path.size()) {
		throw std::runtime_error("subpatcher hierarchy exceeds inspection depth");
	}
	ancestors.insert(patcher);

	std::vector<std::pair<c74::max::t_object *, snapshot_box>> boxes;
	for(
		auto *box = c74::max::jpatcher_get_firstobject(patcher);
		box;
		box = c74::max::jbox_get_nextobject(box)
	) {
		auto box_snapshot = snapshot_box_from_object(box, scope, target_path);
		boxes.emplace_back(box, box_snapshot);
		snapshot.boxes.push_back(std::move(box_snapshot));
	}

	for(
		auto *line = c74::max::jpatcher_get_firstline(patcher);
		line;
		line = c74::max::jpatchline_get_nextline(line)
	) {
		snapshot_connection connection{
			target_path,
			snapshot_endpoint_from_box(
				c74::max::jpatchline_get_box1(line),
				c74::max::jpatchline_get_outletnum(line)
			),
				snapshot_endpoint_from_box(
				c74::max::jpatchline_get_box2(line),
				c74::max::jpatchline_get_inletnum(line)
			)
		};
		collect_snapshot_attributes(line, connection.attributes);
		std::sort(connection.attributes.begin(), connection.attributes.end());
		snapshot.connections.push_back(std::move(connection));
	}

	for(const auto &[box, box_snapshot] : boxes) {
		auto *nested_patcher = child_patcher(box);
		if(!nested_patcher) continue;
		auto nested_path = target_path;
		nested_path.push_back(snapshot_path_component(box_snapshot));
		collect_patch_snapshot(
			nested_patcher,
			scope,
			nested_path,
			ancestors,
			snapshot
		);
	}
	ancestors.erase(patcher);
}

auto make_patch_snapshot(
	c74::max::t_object *root_patcher,
	const std::string &scope
) -> patch_snapshot
{
	patch_snapshot result;
	result.title = symbol_string(c74::max::jpatcher_get_title(root_patcher));
	result.filename = symbol_string(c74::max::jpatcher_get_filename(root_patcher));
	result.filepath = symbol_string(c74::max::jpatcher_get_filepath(root_patcher));
	result.dirty = c74::max::jpatcher_get_dirty(root_patcher) != 0;
	result.locked = c74::max::object_attr_getchar(
		root_patcher,
		c74::max::gensym("locked")
	) != 0;
	result.presentation = c74::max::jpatcher_get_presentation(root_patcher) != 0;

	std::unordered_set<c74::max::t_object *> ancestors;
	collect_patch_snapshot(root_patcher, scope, {}, ancestors, result);
	std::sort(
		result.boxes.begin(),
		result.boxes.end(),
		[](const snapshot_box &left, const snapshot_box &right) {
			const auto left_path = sync_protocol::path_key(left.target_path);
			const auto right_path = sync_protocol::path_key(right.target_path);
			if(left_path != right_path) return left_path < right_path;
			return left.runtime_id < right.runtime_id;
		}
	);
	std::sort(
		result.connections.begin(),
		result.connections.end(),
		[](const snapshot_connection &left, const snapshot_connection &right) {
			const auto left_path = sync_protocol::path_key(left.target_path);
			const auto right_path = sync_protocol::path_key(right.target_path);
			if(left_path != right_path) return left_path < right_path;
			if(left.source.runtime_id != right.source.runtime_id) {
				return left.source.runtime_id < right.source.runtime_id;
			}
			if(left.source.port != right.source.port) {
				return left.source.port < right.source.port;
			}
			if(left.destination.runtime_id != right.destination.runtime_id) {
				return left.destination.runtime_id < right.destination.runtime_id;
			}
			return left.destination.port < right.destination.port;
		}
	);
	return result;
}

auto snapshot_endpoint_json(const snapshot_endpoint &endpoint) -> std::string {
	return "{\"runtimeId\":" +
		json_string(endpoint.runtime_id) +
		",\"varName\":" +
		json_string(endpoint.variable_name) +
		",\"port\":" +
		std::to_string(endpoint.port) +
		"}";
}

auto patch_structure_json(const patch_snapshot &snapshot) -> std::string {
	std::string result{"{\"boxes\":["};
	for(std::size_t index{}; index < snapshot.boxes.size(); index++) {
		if(0 < index) result += ",";
		const auto &box = snapshot.boxes[index];
		result +=
			"{\"targetPath\":" + json_string_array(box.target_path) +
			",\"runtimeId\":" + json_string(box.runtime_id) +
			",\"varName\":" + json_string(box.variable_name) +
			",\"maxclass\":" + json_string(box.max_class) +
			",\"patchingRect\":[" +
			json_number(box.patching_rectangle[0]) + "," +
			json_number(box.patching_rectangle[1]) + "," +
			json_number(box.patching_rectangle[2]) + "," +
			json_number(box.patching_rectangle[3]) + "]" +
			",\"managed\":" + (box.managed ? "true" : "false");
		if(box.has_text) result += ",\"text\":" + json_string(box.text);
		if(box.has_comment) result += ",\"comment\":" + json_string(box.comment);
		result += ",\"attributes\":" + attributes_json(box.attributes);
		result += "}";
	}
	result += "],\"connections\":[";
	for(std::size_t index{}; index < snapshot.connections.size(); index++) {
		if(0 < index) result += ",";
		const auto &connection = snapshot.connections[index];
		result +=
			"{\"targetPath\":" +
			json_string_array(connection.target_path) +
			",\"source\":" +
			snapshot_endpoint_json(connection.source) +
			",\"destination\":" +
			snapshot_endpoint_json(connection.destination) +
			",\"attributes\":" + attributes_json(connection.attributes) +
			"}";
	}
	result += "]}";
	return result;
}

auto patch_structure_token(const patch_snapshot &snapshot) -> std::string {
	return sync_protocol::structure_token(patch_structure_json(snapshot));
}

auto patch_snapshot_json(
	const patch_snapshot &snapshot,
	const std::string &structure
) -> std::string
{
	return
		"{\"title\":" + json_string(snapshot.title) +
		",\"filename\":" + json_string(snapshot.filename) +
		",\"filepath\":" + json_string(snapshot.filepath) +
		",\"dirty\":" + (snapshot.dirty ? "true" : "false") +
		",\"locked\":" + (snapshot.locked ? "true" : "false") +
		",\"presentation\":" + (snapshot.presentation ? "true" : "false") +
		"," + structure.substr(1);
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
	sync_protocol::virtual_patch &state
) {
	const auto current_path = sync_protocol::path_key(path);
	state[current_path];
	for(
		auto *box = c74::max::jpatcher_get_firstobject(patcher);
		box;
		box = c74::max::jbox_get_nextobject(box)
	) {
		const auto *variable_symbol = c74::max::jbox_get_varname(box);
		if(!variable_symbol) continue;
		const std::string variable_name{variable_symbol->s_name};
		if(sync_protocol::managed_id_from_variable_name(scope, variable_name).empty()) continue;

		state[current_path].insert(variable_name);
		auto *nested_patcher = child_patcher(box);
		if(nested_patcher) {
			auto nested_path = path;
			nested_path.push_back(variable_name);
			seed_virtual_patch(nested_patcher, scope, nested_path, state);
		}
	}
}

auto validation_plan_from_operations(
	const patch_plan &plan,
	const std::vector<patch_operation> &operations,
	const std::string &base_revision
)
	-> sync_protocol::validation_plan
{
	sync_protocol::validation_plan result;
	result.scope = plan.scope;
	result.base_revision = base_revision;
	result.operations.reserve(operations.size());

	for(const auto &operation : operations) {
		sync_protocol::validation_operation validation_operation;
		validation_operation.kind = operation.kind;
		validation_operation.target_path = operation.target_path;
		validation_operation.source_variable_name =
			operation.source.variable_name;
		validation_operation.destination_variable_name =
			operation.destination.variable_name;
		validation_operation.variable_name = operation.variable_name;
		validation_operation.created_variable_name = operation.box.variable_name;
		validation_operation.creates_subpatcher =
			operation.box.creates_subpatcher;
		result.operations.push_back(validation_operation);
	}
	return result;
}

void validate_plan_against_patch(
	const patch_plan &plan,
	c74::max::t_object *root_patcher,
	const std::string &configured_scope,
	const std::string &current_revision
) {
	sync_protocol::virtual_patch state;
	seed_virtual_patch(root_patcher, plan.scope, {}, state);
	const auto target_state = sync_protocol::validate_plan(
		validation_plan_from_operations(
			plan,
			plan.operations,
			plan.base_revision
		),
		state,
		configured_scope,
		current_revision
	);
	if(plan.has_rollback_operations) {
		const auto restored_state = sync_protocol::validate_plan(
			validation_plan_from_operations(
				plan,
				plan.rollback_operations,
				plan.target_revision
			),
			target_state,
			configured_scope,
			plan.target_revision
		);
		if(restored_state != state) {
			throw std::runtime_error(
				"rollback operations do not restore managed box topology"
			);
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

auto patcher_contains_maxforge_sync(c74::max::t_object *patcher) -> bool {
	for(
		auto *box = c74::max::jpatcher_get_firstobject(patcher);
		box;
		box = c74::max::jbox_get_nextobject(box)
	) {
		auto *object = c74::max::jbox_get_object(box);
		if(
			object &&
			symbol_string(c74::max::object_classname(object)) == "maxforge.sync"
		) {
			return true;
		}
		bool has_text{};
		const auto text = box_text(box, has_text);
		if(
			has_text &&
			text.rfind("maxforge.sync", 0) == 0 &&
			(text.size() == 13 || text[13] == ' ')
		) {
			return true;
		}
	}
	return false;
}

void inject_bridge_object(
	c74::max::t_object *patcher,
	const std::string &patcher_id,
	const std::string &scope,
	const std::string &host,
	long port,
	const std::string &token
) {
	auto object_text =
		"maxforge.sync @host " + host +
		" @port " + std::to_string(port) +
		" @scope " + scope +
		" @patcher_id " + patcher_id +
		" @controller 0";
	if(!token.empty()) object_text += " @token " + token;

	auto *specification = c74::max::dictionary_new();
	if(!specification) {
		throw std::runtime_error("Max could not allocate bridge object definition");
	}
	c74::max::dictionary_appendsym(
		specification,
		c74::max::gensym("maxclass"),
		c74::max::gensym("newobj")
	);
	c74::max::dictionary_appendsym(
		specification,
		c74::max::gensym("varname"),
		c74::max::gensym("maxforge_mcp_bridge")
	);
	std::array<c74::max::t_atom, 4> rectangle{};
	const std::array<double, 4> values{30, 30, 680, 22};
	for(std::size_t index{}; index < rectangle.size(); index++) {
		c74::max::atom_setfloat(rectangle.data() + index, values[index]);
	}
	c74::max::dictionary_appendatoms(
		specification,
		c74::max::gensym("patching_rect"),
		static_cast<long>(rectangle.size()),
		rectangle.data()
	);
	c74::max::dictionary_appendstring(
		specification,
		c74::max::gensym("text"),
		object_text.c_str()
	);
	auto *created_box = c74::max::newobject_fromdictionary(
		patcher,
		specification
	);
	c74::max::object_free(specification);
	if(!created_box) {
		throw std::runtime_error("Max could not inject maxforge.sync");
	}
}

void dispose_patcher_deferred(
	void *patcher,
	c74::max::t_symbol *,
	short,
	c74::max::t_atom *
) {
	if(!patcher) return;
	c74::max::object_method(patcher, c74::max::gensym("dispose"));
}

auto apply_set(
	c74::max::t_object *patcher,
	const patch_operation &operation
) -> bool
{
	auto *box = find_named_box(patcher, operation.variable_name);
	if(!box) return false;

	auto *attribute = c74::max::gensym(operation.attribute.c_str());
	auto *target = box;
	if(c74::max::object_attr_usercanset(target, attribute) == 0) {
		target = c74::max::jbox_get_object(box);
	}
	if(!target || c74::max::object_attr_usercanset(target, attribute) == 0) {
		return false;
	}
	return c74::max::object_attr_setvalueof(
		target,
		attribute,
		static_cast<long>(operation.value.size()),
		const_cast<c74::max::t_atom *>(operation.value.data())
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

auto apply_rollback_operation(
	c74::max::t_object *root_patcher,
	const patch_operation &operation
) -> bool
{
	auto *target_patcher = resolve_target_patcher(
		root_patcher,
		operation.target_path
	);
	if(!target_patcher) {
		return operation.kind == operation_kind::disconnect ||
			operation.kind == operation_kind::delete_box;
	}

	if(operation.kind == operation_kind::disconnect) {
		// The forward prefix may never have created this cord. Absence already
		// satisfies the reverse operation.
		(void)apply_connection(target_patcher, operation, "disconnect");
		return true;
	}
	if(operation.kind == operation_kind::delete_box) {
		auto *box = find_named_box(target_patcher, operation.variable_name);
		if(box) c74::max::object_free(box);
		return true;
	}
	if(operation.kind == operation_kind::create) {
		if(auto *box = find_named_box(
			target_patcher,
			operation.box.variable_name
		)) {
			c74::max::object_free(box);
		}
		return apply_create(target_patcher, operation.box);
	}
	return apply_operation(root_patcher, operation);
}

auto dictionary_from_json(const std::string &json) -> c74::max::t_dictionary * {
	c74::max::t_dictionary *dictionary{};
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

auto dictionary_from_atoms(
	const c74::min::atoms &arguments
) -> c74::max::t_dictionary *
{
	if(arguments.empty()) throw std::runtime_error("apply requires a JSON plan");

	if(
		arguments.size() == 1 &&
		c74::max::atom_gettype(&arguments.front()) == c74::max::A_SYM
	) {
		const std::string json = arguments.front();
		return dictionary_from_json(json);
	}

	c74::max::t_dictionary *dictionary{};
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
	MIN_DESCRIPTION{"Connect Max to maxforge MCP and synchronize a live patcher"};
	MIN_TAGS{"patcher, scripting, agent, websocket"};
	MIN_AUTHOR{"2bit"};

	c74::min::inlet<> input{
		this,
		"(anything) connect, disconnect, status, apply, validate, inspect, revision"
	};
	c74::min::outlet<> status_output{this, "(anything) status and errors"};

	c74::min::attribute<c74::min::symbol> host{
		this,
		"host",
		"127.0.0.1",
		c74::min::description{"maxforge MCP WebSocket host"}
	};

	c74::min::attribute<long> port{
		this,
		"port",
		8766,
		c74::min::description{"maxforge MCP WebSocket port"},
		c74::min::range{1, 65535}
	};

	c74::min::attribute<c74::min::symbol> token{
		this,
		"token",
		"",
		c74::min::description{"Shared token required for LAN connections"}
	};

	c74::min::attribute<long> reconnect{
		this,
		"reconnect",
		1,
		c74::min::description{"Automatically reconnect to the maxforge MCP bridge"},
		c74::min::range{0, 1}
	};

	c74::min::attribute<long> reconnect_interval{
		this,
		"reconnect_interval",
		1000,
		c74::min::description{"WebSocket reconnect interval in milliseconds"},
		c74::min::range{100, 60000}
	};

	c74::min::attribute<c74::min::symbol> scope{
		this,
		"scope",
		"default",
		c74::min::description{"Managed maxforge scope"}
	};

	c74::min::attribute<c74::min::symbol> patcher_id{
		this,
		"patcher_id",
		"default",
		c74::min::description{"Stable MCP routing ID for the containing patcher"}
	};

	c74::min::attribute<long> controller{
		this,
		"controller",
		0,
		c74::min::description{"Allow this patcher to create top-level patches"}
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
			const std::string revision_value{revision.c_str()};
			status_output.send(
				"revision",
				revision_value.empty() ? "uninitialized" : revision
			);
			send_revision_event(revision_value);
			return {};
		}
	};

	c74::min::message<> register_message{
		this,
		"register",
		"Register the containing patcher with the MCP bridge",
		MIN_FUNCTION {
			send_registration_event(true);
			return {};
		}
	};

	c74::min::message<> inspect_message{
		this,
		"inspect",
		"Output a structural snapshot of the containing patcher",
		MIN_FUNCTION {
			std::string request_id{"local"};
			if(!args.empty()) {
				const c74::min::symbol request_symbol = args.front();
				request_id = request_symbol.c_str();
			}
			send_patch_snapshot(request_id);
			return {};
		}
	};

	c74::min::message<> connect_message{
		this,
		"connect",
		"Connect to the maxforge MCP WebSocket bridge",
		MIN_FUNCTION {
			connect_transport();
			return {};
		}
	};

	c74::min::message<> disconnect_message{
		this,
		"disconnect",
		"Disconnect from the maxforge MCP WebSocket bridge",
		MIN_FUNCTION {
			disconnect_transport();
			return {};
		}
	};

	c74::min::message<> restart_message{
		this,
		"restart",
		"Restart the maxforge MCP WebSocket connection",
		MIN_FUNCTION {
			disconnect_transport();
			connect_transport();
			return {};
		}
	};

	c74::min::message<> transport_status_message{
		this,
		"status",
		"Output the maxforge MCP WebSocket connection status",
		MIN_FUNCTION {
			status_output.send("status", transport_status_label());
			return {};
		}
	};

	c74::min::message<> notify_message{
		this,
		"notify",
		MIN_FUNCTION {
			const c74::min::notification notification{args};
			const c74::min::symbol registration = notification.registration();
			const c74::min::symbol name = notification.name();
			record_edit_notification(
				registration.c_str(),
				name.c_str(),
				notification.source()
			);
			return {c74::max::MAX_ERR_NONE};
		}
	};

	maxforge_sync() {
		instance_id_ = make_instance_id(this);
		websocket_client_.set_notifier([this]() {
			transport_queue_.set();
		});
		init_timer_.delay(0);
	}

	~maxforge_sync() {
		observation_timer_.stop();
		observation_release_timer_.stop();
		for(auto *patcher : observed_patchers_) {
			c74::max::object_detach_byptr(maxobj(), patcher);
		}
		observed_patchers_.clear();
		websocket_client_.clear_notifier();
		websocket_client_.disconnect();
	}

private:
	enum class registration_result {
		sent,
		retry,
		failed
	};

	c74::min::queue<> transport_queue_{this, MIN_FUNCTION {
		deliver_transport_events();
		return {};
	}};

	bbb::agent::websocket_client websocket_client_;

	c74::min::timer<c74::min::timer_options::defer_delivery> init_timer_{
		this,
		MIN_FUNCTION {
			connect_transport();
			end_agent_mutation();
			return {};
		}
	};

	c74::min::timer<c74::min::timer_options::defer_delivery> observation_timer_{
		this,
		MIN_FUNCTION {
			if(edit_observation_suppressed_) {
				pending_edit_causes_.clear();
				return {};
			}
			try {
				refresh_observed_patchers();
				send_edit_observation();
			} catch(const std::exception &exception) {
				send_error(exception.what(), "observe");
			}
			return {};
		}
	};

	c74::min::timer<c74::min::timer_options::defer_delivery>
	observation_release_timer_{
		this,
		MIN_FUNCTION {
			edit_observation_suppressed_ = false;
			return {};
		}
	};

	c74::min::timer<c74::min::timer_options::defer_delivery> registration_timer_{
		this,
		MIN_FUNCTION {
			if(!transport_open_ || registration_sent_) return {};
			const auto result = send_registration_event(false);
			if(result == registration_result::retry) {
				registration_timer_.delay(100);
			}
			return {};
		}
	};

	bool transport_open_{false};
	bool registration_sent_{false};
	bool edit_observation_suppressed_{true};
	std::unordered_set<c74::max::t_object *> observed_patchers_;
	std::unordered_set<sync_protocol::edit_observation_cause> pending_edit_causes_;
	std::string last_observed_structure_token_;
	std::string last_transport_error_;
	std::string instance_id_;

	auto transport_status_label() const -> const char * {
		switch(websocket_client_.state()) {
			case bbb::agent::websocket_state::connecting:
				return "connecting";
			case bbb::agent::websocket_state::open:
				return "connected";
			case bbb::agent::websocket_state::closing:
			case bbb::agent::websocket_state::closed:
				return "disconnected";
		}
		return "disconnected";
	}

	auto websocket_url() const -> std::string {
		const c74::min::symbol host_symbol = host;
		const std::string host_value{host_symbol.c_str()};
		if(!sync_protocol::is_valid_network_host(host_value)) {
			throw std::runtime_error("invalid @host");
		}
		const c74::min::symbol token_symbol = token;
		const std::string token_value{token_symbol.c_str()};
		if(!token_value.empty() && !sync_protocol::is_valid_auth_token(token_value)) {
			throw std::runtime_error(
				"@token must contain 1 to 256 URL-safe characters"
			);
		}
		if(!sync_protocol::is_loopback_host(host_value) && token_value.empty()) {
			throw std::runtime_error("@token is required for a non-loopback @host");
		}
		const long port_value = port;
		if(port_value < 1 || 65535 < port_value) {
			throw std::runtime_error("invalid @port");
		}
		const auto authority = host_value.find(':') != std::string::npos
			? "[" + host_value + "]"
			: host_value;
		return "ws://" + authority + ":" + std::to_string(port_value);
	}

	auto send_authentication_event() -> bool {
		const c74::min::symbol token_symbol = token;
		const std::string token_value{token_symbol.c_str()};
		if(token_value.empty()) return true;
		if(!sync_protocol::is_valid_auth_token(token_value)) {
			report_transport_error(
				"@token must contain 1 to 256 URL-safe characters"
			);
			return false;
		}
		if(websocket_client_.send(
			"{\"type\":\"maxforge.authenticate\",\"token\":" +
			json_string(token_value) +
			"}"
		)) {
			return true;
		}
		report_transport_error("could not authenticate with maxforge MCP bridge");
		return false;
	}

	void connect_transport() {
		try {
			const long interval = reconnect_interval;
			if(interval < 100 || 60000 < interval) {
				throw std::runtime_error("invalid @reconnect_interval");
			}
			transport_open_ = false;
			registration_sent_ = false;
			status_output.send("status", "connecting");
			websocket_client_.connect(
				websocket_url(),
				static_cast<long>(reconnect) != 0,
				static_cast<std::uint32_t>(interval)
			);
		} catch(const std::exception &exception) {
			report_transport_error(exception.what());
		} catch(...) {
			report_transport_error("unknown WebSocket connection error");
		}
	}

	void disconnect_transport() {
		transport_open_ = false;
		registration_sent_ = false;
		websocket_client_.disconnect();
		status_output.send("status", "disconnected");
	}

	void deliver_transport_events() {
		for(auto &event : websocket_client_.drain_events()) {
			switch(event.type) {
				case bbb::agent::websocket_event_type::open:
					transport_open_ = true;
					registration_sent_ = false;
					last_transport_error_.clear();
					status_output.send("status", "connected");
					if(send_authentication_event()) registration_timer_.delay(0);
					break;
				case bbb::agent::websocket_event_type::close:
					transport_open_ = false;
					registration_sent_ = false;
					if(event.close_code == 1008 && !event.text.empty()) {
						report_transport_error("WebSocket: " + event.text);
					}
					status_output.send("status", "disconnected");
					break;
				case bbb::agent::websocket_event_type::message:
					process_json(event.text);
					break;
				case bbb::agent::websocket_event_type::error:
					report_transport_error(
						"WebSocket: " +
						(event.text.empty() ? "unknown error" : event.text)
					);
					break;
			}
		}
	}

	void process_json(const std::string &json) {
		c74::max::t_dictionary *dictionary{};
		try {
			dictionary = dictionary_from_json(json);
			process_dictionary(dictionary, true);
			c74::max::object_free(dictionary);
		} catch(const std::exception &exception) {
			if(dictionary) c74::max::object_free(dictionary);
			send_error(exception.what(), "transport");
		} catch(...) {
			if(dictionary) c74::max::object_free(dictionary);
			send_error("unknown transport message error", "transport");
		}
	}

	void report_transport_error(const std::string &message) {
		if(message != last_transport_error_) {
			cerr << message << c74::min::endl;
			last_transport_error_ = message;
		}
		status_output.send("error", message);
	}

	auto configured_patcher_id() const -> std::string {
		const c74::min::symbol value_symbol = patcher_id;
		const std::string value{value_symbol.c_str()};
		if(!sync_protocol::is_valid_patcher_id(value)) {
			throw std::runtime_error("invalid @patcher_id: " + value);
		}
		return value;
	}

	auto configured_scope() const -> std::string {
		const c74::min::symbol value_symbol = scope;
		const std::string value{value_symbol.c_str()};
		if(!sync_protocol::is_valid_scope(value)) {
			throw std::runtime_error("invalid @scope: " + value);
		}
		return value;
	}

	void collect_observable_patchers(
		c74::max::t_object *patcher,
		std::size_t depth,
		std::unordered_set<c74::max::t_object *> &patchers
	) {
		if(!patcher || patchers.count(patcher) != 0) return;
		if(32 <= depth) {
			throw std::runtime_error("subpatcher hierarchy exceeds observation depth");
		}
		patchers.insert(patcher);
		for(
			auto *box = c74::max::jpatcher_get_firstobject(patcher);
			box;
			box = c74::max::jbox_get_nextobject(box)
		) {
			auto *nested_patcher = child_patcher(box);
			if(nested_patcher) {
				collect_observable_patchers(
					nested_patcher,
					depth + 1,
					patchers
				);
			}
		}
	}

	void refresh_observed_patchers() {
		std::unordered_set<c74::max::t_object *> patchers;
		collect_observable_patchers(top_level_patcher(), 0, patchers);
		for(auto *patcher : patchers) {
			if(observed_patchers_.count(patcher) != 0) continue;
			const auto error = c74::max::object_attach_byptr(maxobj(), patcher);
			if(error != c74::max::MAX_ERR_NONE) {
				throw std::runtime_error("could not observe a patcher");
			}
			observed_patchers_.insert(patcher);
		}
	}

	void record_edit_notification(
		const std::string &registration,
		const std::string &notification,
		c74::max::t_object *source
	) {
		if(notification == "free" && source) {
			observed_patchers_.erase(source);
		}
		if(
			edit_observation_suppressed_ ||
			!transport_open_ ||
			!registration_sent_
		) {
			return;
		}
		pending_edit_causes_.insert(
			sync_protocol::edit_observation_cause_from_registration(
				registration,
				notification
			)
		);
		observation_timer_.delay(75);
	}

	void begin_agent_mutation() {
		edit_observation_suppressed_ = true;
		observation_timer_.stop();
		observation_release_timer_.stop();
		pending_edit_causes_.clear();
	}

	void end_agent_mutation() {
		observation_timer_.stop();
		pending_edit_causes_.clear();
		try {
			refresh_observed_patchers();
			last_observed_structure_token_ = patch_structure_token(
				make_patch_snapshot(top_level_patcher(), configured_scope())
			);
		} catch(const std::exception &exception) {
			last_observed_structure_token_.clear();
			send_error(exception.what(), "observe");
		} catch(...) {
			last_observed_structure_token_.clear();
			send_error("unknown edit observation error", "observe");
		}
		observation_release_timer_.delay(0);
	}

	void cancel_agent_mutation() {
		observation_timer_.stop();
		pending_edit_causes_.clear();
		observation_release_timer_.delay(0);
	}

	void send_edit_observation() {
		if(pending_edit_causes_.empty()) return;
		auto *root_patcher = top_level_patcher();
		const auto current_scope = configured_scope();
		const auto current_patcher_id = configured_patcher_id();
		const c74::min::symbol revision_symbol = revision_state;
		const std::string revision{revision_symbol.c_str()};
		const auto snapshot = make_patch_snapshot(root_patcher, current_scope);
		const auto structure = patch_structure_json(snapshot);
		const auto current_structure_token =
			sync_protocol::structure_token(structure);
		if(current_structure_token == last_observed_structure_token_) {
			pending_edit_causes_.clear();
			return;
		}

		std::string causes{"["};
		const std::array<sync_protocol::edit_observation_cause, 5> order{
			sync_protocol::edit_observation_cause::patcher,
			sync_protocol::edit_observation_cause::box,
			sync_protocol::edit_observation_cause::line,
			sync_protocol::edit_observation_cause::attribute,
			sync_protocol::edit_observation_cause::unknown
		};
		bool first{true};
		for(const auto cause : order) {
			if(pending_edit_causes_.count(cause) == 0) continue;
			if(!first) causes += ",";
			first = false;
			causes += json_string(
				sync_protocol::edit_observation_cause_name(cause)
			);
		}
		causes += "]";
		pending_edit_causes_.clear();
		last_observed_structure_token_ = current_structure_token;

		send_event(
			"{\"type\":\"maxforge.edit.observed\",\"patcherId\":" +
			json_string(current_patcher_id) +
			",\"scope\":" +
			json_string(current_scope) +
			",\"revision\":" +
			(revision.empty() ? "null" : json_string(revision)) +
			",\"structureToken\":" +
			json_string(current_structure_token) +
			",\"causes\":" +
			causes +
			",\"patcher\":" +
			patch_snapshot_json(snapshot, structure) +
			"}"
		);
	}

	auto top_level_patcher() -> c74::max::t_object * {
		c74::max::t_object *containing_patcher{};
		const auto patcher_error = c74::max::object_obex_lookup(
			maxobj(),
			c74::max::gensym("#P"),
			&containing_patcher
		);
		if(patcher_error != c74::max::MAX_ERR_NONE || !containing_patcher) {
			throw std::runtime_error("could not access the containing patcher");
		}
		auto *top_level = c74::max::jpatcher_get_toppatcher(
			containing_patcher
		);
		return top_level ? top_level : containing_patcher;
	}

	auto visible_view(c74::max::t_object *patcher) -> c74::max::t_object * {
		for(
			auto *view = c74::max::jpatcher_get_firstview(patcher);
			view;
			view = c74::max::patcherview_get_nextview(view)
		) {
			if(c74::max::patcherview_get_visible(view) != 0) return view;
		}
		return nullptr;
	}

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
		std::string request_id{"local"};
		std::string event_patcher_id;
		std::string event_scope;
		bool agent_mutation_started{};
		try {
			std::string message_type;
			if(dictionary_optional_string(dictionary, "type", message_type)) {
				request_id = dictionary_string(dictionary, "requestId");
				if(request_id.empty() || 128 < request_id.size()) {
					throw std::runtime_error("invalid MCP request id");
				}
				event_patcher_id = dictionary_string(dictionary, "patcherId");
				if(!sync_protocol::is_valid_patcher_id(event_patcher_id)) {
					throw std::runtime_error("invalid request patcherId");
				}

				if(message_type == "maxforge.create_patch.request") {
					event_scope = dictionary_string(dictionary, "scope");
					if(!sync_protocol::is_valid_scope(event_scope)) {
						throw std::runtime_error("invalid requested patch scope");
					}
					const long is_controller = controller;
					if(is_controller == 0) {
						throw std::runtime_error(
							"this maxforge.sync is not a patch-creation controller"
						);
					}
					const auto title = dictionary_string(dictionary, "title");
					if(title.empty() || 256 < title.size()) {
						throw std::runtime_error(
							"patch title must contain between 1 and 256 characters"
						);
					}
					const c74::min::symbol host_symbol = host;
					const std::string host_value{host_symbol.c_str()};
					const c74::min::symbol token_symbol = token;
					const std::string token_value{token_symbol.c_str()};
					const long port_value = port;
					if(port_value < 1 || 65535 < port_value) {
						throw std::runtime_error("invalid new patch WebSocket port");
					}
					(void)websocket_url();
					create_bridge_patch(
						event_patcher_id,
						event_scope,
						title,
						host_value,
						port_value,
						token_value
					);
					send_patch_created_event(
						request_id,
						event_patcher_id,
						event_scope
					);
					return;
				}

				if(message_type == "maxforge.open_patch.request") {
					event_scope = dictionary_string(dictionary, "scope");
					if(!sync_protocol::is_valid_scope(event_scope)) {
						throw std::runtime_error("invalid requested patch scope");
					}
					const long is_controller = controller;
					if(is_controller == 0) {
						throw std::runtime_error(
							"this maxforge.sync is not a patch-creation controller"
						);
					}
					const auto title = dictionary_string(dictionary, "title");
					if(title.empty() || 256 < title.size()) {
						throw std::runtime_error(
							"patch title must contain between 1 and 256 characters"
						);
					}
					const auto patch_path = dictionary_string(dictionary, "path");
					const auto resolved_path = resolve_patch_path(patch_path);
					if(!patch_path_exists(resolved_path)) {
						throw std::runtime_error(
							"patch file does not exist on the Max host: " + patch_path
						);
					}
					const c74::min::symbol host_symbol = host;
					const std::string host_value{host_symbol.c_str()};
					const c74::min::symbol token_symbol = token;
					const std::string token_value{token_symbol.c_str()};
					const long port_value = port;
					(void)websocket_url();

					auto *opened_patcher = reinterpret_cast<c74::max::t_object *>(
						c74::max::jpatcher_load(
							resolved_path.filename.data(),
							resolved_path.path_id,
							0,
							nullptr
						)
					);
					if(!opened_patcher) {
						throw std::runtime_error("Max could not open patch: " + patch_path);
					}
					if(patcher_contains_maxforge_sync(opened_patcher)) {
						c74::max::jpatcher_set_dirty(opened_patcher, 0);
						c74::max::object_method(
							opened_patcher,
							c74::max::gensym("dispose")
						);
						throw std::runtime_error(
							"opened patch already contains maxforge.sync; "
							"open it normally and use its configured patcher_id"
						);
					}
					try {
						inject_bridge_object(
							opened_patcher,
							event_patcher_id,
							event_scope,
							host_value,
							port_value,
							token_value
						);
						c74::max::jpatcher_set_title(
							opened_patcher,
							c74::max::gensym(title.c_str())
						);
						c74::max::jpatcher_set_dirty(opened_patcher, 1);
						c74::max::jpatcher_set_locked(opened_patcher, 0);
						c74::max::object_method(
							opened_patcher,
							c74::max::gensym("front")
						);
					} catch(...) {
						c74::max::jpatcher_set_dirty(opened_patcher, 0);
						c74::max::object_method(
							opened_patcher,
							c74::max::gensym("dispose")
						);
						throw;
					}
					send_patch_opened_event(
						request_id,
						event_patcher_id,
						event_scope
					);
					return;
				}

				if(event_patcher_id != configured_patcher_id()) {
					throw std::runtime_error(
						"request patcherId \"" + event_patcher_id +
						"\" does not match @patcher_id \"" +
						configured_patcher_id() + "\""
					);
				}
				if(message_type != "maxforge.apply.request") {
					event_scope = dictionary_string(dictionary, "scope");
					if(event_scope != configured_scope()) {
						throw std::runtime_error(
							"request scope \"" + event_scope +
							"\" does not match @scope \"" +
							configured_scope() + "\""
						);
					}
				}

				if(message_type == "maxforge.save_patch.request") {
					auto *root_patcher = top_level_patcher();
					std::string destination;
					const auto has_destination = dictionary_optional_string(
						dictionary,
						"path",
						destination
					);
					const auto overwrite = dictionary_long(dictionary, "overwrite") != 0;
					c74::max::t_max_err write_error{};
					if(has_destination) {
						const auto resolved_path = resolve_patch_path(destination);
						if(!overwrite && patch_path_exists(resolved_path)) {
							throw std::runtime_error(
								"save destination already exists; set overwrite=true: " +
								destination
							);
						}
						c74::max::t_atom argument{};
						c74::max::atom_setsym(
							&argument,
							c74::max::gensym(destination.c_str())
						);
						write_error = c74::max::object_method_typed(
							root_patcher,
							c74::max::gensym("write"),
							1,
							&argument,
							nullptr
						);
					} else {
						if(symbol_string(
							c74::max::jpatcher_get_filepath(root_patcher)
						).empty()) {
							throw std::runtime_error(
								"unsaved patch requires an explicit save path"
							);
						}
						write_error = c74::max::object_method_typed(
							root_patcher,
							c74::max::gensym("write"),
							0,
							nullptr,
							nullptr
						);
					}
					if(write_error != c74::max::MAX_ERR_NONE) {
						throw std::runtime_error("Max rejected patch write request");
					}
					if(c74::max::jpatcher_get_dirty(root_patcher) != 0) {
						throw std::runtime_error(
							"Max did not complete patch save synchronously"
						);
					}
					send_patch_saved_event(request_id, root_patcher);
					return;
				}

				if(message_type == "maxforge.close_patch.request") {
					auto *root_patcher = top_level_patcher();
					const auto discard = dictionary_long(dictionary, "discard") != 0;
					const auto dirty = c74::max::jpatcher_get_dirty(root_patcher) != 0;
					if(dirty && !discard) {
						throw std::runtime_error(
							"patch has unsaved changes; save it or set discard=true"
						);
					}
					if(dirty) c74::max::jpatcher_set_dirty(root_patcher, 0);
					send_patch_closing_event(request_id, dirty && discard);
					c74::max::defer_low(
						root_patcher,
						reinterpret_cast<c74::max::method>(dispose_patcher_deferred),
						nullptr,
						0,
						nullptr
					);
					return;
				}

				if(message_type == "maxforge.inspect.request") {
					send_patch_snapshot(request_id);
					return;
				}

				if(message_type == "maxforge.apply.request") {
					dictionary = dictionary_child(dictionary, "plan");
				} else {
					throw std::runtime_error(
						"unsupported maxforge request type: " + message_type
					);
				}
			}

			const auto plan = parse_plan(dictionary);
			event_scope = plan.scope;
			auto *root_patcher = top_level_patcher();
			const auto current_scope = configured_scope();
			const c74::min::symbol revision_symbol = revision_state;
			const std::string current_revision{revision_symbol.c_str()};
			if(plan.has_base_structure_token) {
				const auto snapshot = make_patch_snapshot(
					root_patcher,
					current_scope
				);
				sync_protocol::validate_structure_token(
					plan.base_structure_token,
					patch_structure_json(snapshot)
				);
			}
			validate_plan_against_patch(
				plan,
				root_patcher,
				current_scope,
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
			begin_agent_mutation();
			agent_mutation_started = true;

			for(std::size_t index{}; index < plan.operations.size(); index++) {
				if(!apply_operation(
					root_patcher,
					plan.operations[index]
				)) {
					if(!plan.has_rollback_operations) {
						throw std::runtime_error(
							"operation " + std::to_string(index) +
							" failed; no rollback operations were supplied and the "
							"patch may be partially modified"
						);
					}
					std::vector<std::size_t> rollback_failures;
					for(
						std::size_t rollback_index{};
						rollback_index < plan.rollback_operations.size();
						rollback_index++
					) {
						if(!apply_rollback_operation(
							root_patcher,
							plan.rollback_operations[rollback_index]
						)) {
							rollback_failures.push_back(rollback_index);
						}
					}
					if(rollback_failures.empty()) {
						throw std::runtime_error(
							"operation " + std::to_string(index) +
							" failed; reverse operations completed and the managed "
							"revision was not advanced"
						);
					}
					throw std::runtime_error(
						"operation " + std::to_string(index) +
						" failed and rollback operation " +
						std::to_string(rollback_failures.front()) +
						" also failed; inspect the patch before retrying"
					);
				}
			}

			revision_state = c74::min::symbol{plan.target_revision};
			status_output.send(
				"applied",
				plan.target_revision,
				static_cast<long>(plan.operations.size())
			);
			send_applied_event(plan, request_id);
			end_agent_mutation();
			agent_mutation_started = false;
		} catch(const std::exception &exception) {
			if(agent_mutation_started) cancel_agent_mutation();
			send_error(
				exception.what(),
				request_id,
				event_patcher_id,
				event_scope
			);
		} catch(...) {
			if(agent_mutation_started) cancel_agent_mutation();
			send_error(
				"unknown plan processing error",
				request_id,
				event_patcher_id,
				event_scope
			);
		}
	}

	void send_patch_snapshot(const std::string &request_id) {
		try {
			auto *root_patcher = top_level_patcher();
			const auto current_scope = configured_scope();
			const auto current_patcher_id = configured_patcher_id();
			const c74::min::symbol revision_symbol = revision_state;
			const std::string revision{revision_symbol.c_str()};
			const auto snapshot = make_patch_snapshot(
				root_patcher,
				current_scope
			);
			const auto structure = patch_structure_json(snapshot);
			const auto structure_token =
				sync_protocol::structure_token(structure);
			send_event(
				"{\"type\":\"maxforge.snapshot\",\"requestId\":" +
				json_string(request_id) +
				",\"patcherId\":" +
				json_string(current_patcher_id) +
				",\"scope\":" +
				json_string(current_scope) +
				",\"revision\":" +
				(revision.empty() ? "null" : json_string(revision)) +
				",\"structureToken\":" +
				json_string(structure_token) +
				",\"patcher\":" +
				patch_snapshot_json(snapshot, structure) +
				"}"
			);
		} catch(const std::exception &exception) {
			send_error(exception.what(), request_id);
		} catch(...) {
			send_error("unknown patch inspection error", request_id);
		}
	}

	auto send_registration_event(bool report_invisible) -> registration_result {
		try {
			if(!transport_open_) {
				if(report_invisible) {
					report_transport_error(
						"cannot register while WebSocket is disconnected"
					);
				}
				return registration_result::failed;
			}
			auto *root_patcher = top_level_patcher();
			auto *view = visible_view(root_patcher);
			if(!view) {
				if(report_invisible) {
					send_error(
						"containing patcher does not have a visible window",
						"register"
					);
				}
				return registration_result::retry;
			}
			c74::max::patcherview_set_locked(view, 0);
			const auto current_patcher_id = configured_patcher_id();
			const auto current_scope = configured_scope();
			const c74::min::symbol revision_symbol = revision_state;
			const std::string revision{revision_symbol.c_str()};
			const long is_controller = controller;
			const auto observation_baseline = make_patch_snapshot(
				root_patcher,
				current_scope
			);
			const auto observation_baseline_structure =
				patch_structure_json(observation_baseline);
			const auto observation_baseline_token =
				sync_protocol::structure_token(observation_baseline_structure);
			const auto filename = symbol_string(
				c74::max::jpatcher_get_filename(root_patcher)
			);
			auto title = symbol_string(
				c74::max::jpatcher_get_title(root_patcher)
			);
			if(title.empty()) title = filename;
			if(!send_event(
				"{\"type\":\"maxforge.registered\",\"patcherId\":" +
				json_string(current_patcher_id) +
				",\"scope\":" +
				json_string(current_scope) +
				",\"instanceId\":" +
				json_string(instance_id_) +
				",\"revision\":" +
				(revision.empty() ? "null" : json_string(revision)) +
				",\"controller\":" +
				(is_controller == 0 ? "false" : "true") +
				",\"title\":" +
				json_string(title) +
				",\"filename\":" +
				json_string(filename) +
				",\"filepath\":" +
				json_string(symbol_string(c74::max::jpatcher_get_filepath(root_patcher))) +
				",\"externalVersion\":" +
				json_string(MAXFORGE_PACKAGE_VERSION) +
				",\"capabilities\":[\"edit_observation_v1\",\"session_baseline_v1\"]" +
				",\"observationBaseline\":{\"structureToken\":" +
				json_string(observation_baseline_token) +
				",\"patcher\":" +
				patch_snapshot_json(
					observation_baseline,
					observation_baseline_structure
				) +
				"}" +
				"}"
			)) {
				return registration_result::failed;
			}
			registration_sent_ = true;
			begin_agent_mutation();
			refresh_observed_patchers();
			last_observed_structure_token_ = observation_baseline_token;
			observation_release_timer_.delay(0);
			return registration_result::sent;
		} catch(const std::exception &exception) {
			send_error(exception.what(), "register");
		} catch(...) {
			send_error("unknown patch registration error", "register");
		}
		return registration_result::failed;
	}

	void send_error(
		const std::string &message,
		const std::string &request_id = "local",
		const std::string &event_patcher_id = "",
		const std::string &event_scope = ""
	) {
		cerr << message << c74::min::endl;
		status_output.send("error", message);
		std::string resolved_patcher_id{event_patcher_id};
		std::string resolved_scope{event_scope};
		if(!sync_protocol::is_valid_patcher_id(resolved_patcher_id)) {
			const c74::min::symbol value_symbol = patcher_id;
			resolved_patcher_id = value_symbol.c_str();
		}
		if(!sync_protocol::is_valid_patcher_id(resolved_patcher_id)) {
			resolved_patcher_id = "default";
		}
		if(!sync_protocol::is_valid_scope(resolved_scope)) {
			const c74::min::symbol value_symbol = scope;
			resolved_scope = value_symbol.c_str();
		}
		if(!sync_protocol::is_valid_scope(resolved_scope)) resolved_scope = "default";
		send_event(
			"{\"type\":\"maxforge.error\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(resolved_patcher_id) +
			",\"scope\":" +
			json_string(resolved_scope) +
			",\"message\":" +
			json_string(message) +
			"}"
		);
	}

	void send_patch_created_event(
		const std::string &request_id,
		const std::string &created_patcher_id,
		const std::string &created_scope
	) {
		send_event(
			"{\"type\":\"maxforge.patch.created\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(created_patcher_id) +
			",\"scope\":" +
			json_string(created_scope) +
			"}"
		);
	}

	void send_patch_opened_event(
		const std::string &request_id,
		const std::string &opened_patcher_id,
		const std::string &opened_scope
	) {
		send_event(
			"{\"type\":\"maxforge.patch.opened\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(opened_patcher_id) +
			",\"scope\":" +
			json_string(opened_scope) +
			"}"
		);
	}

	void send_patch_saved_event(
		const std::string &request_id,
		c74::max::t_object *patcher
	) {
		send_event(
			"{\"type\":\"maxforge.patch.saved\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(configured_patcher_id()) +
			",\"scope\":" +
			json_string(configured_scope()) +
			",\"filename\":" +
			json_string(symbol_string(c74::max::jpatcher_get_filename(patcher))) +
			",\"filepath\":" +
			json_string(symbol_string(c74::max::jpatcher_get_filepath(patcher))) +
			",\"dirty\":" +
			(c74::max::jpatcher_get_dirty(patcher) == 0 ? "false" : "true") +
			"}"
		);
	}

	void send_patch_closing_event(
		const std::string &request_id,
		bool discarded
	) {
		send_event(
			"{\"type\":\"maxforge.patch.closing\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(configured_patcher_id()) +
			",\"scope\":" +
			json_string(configured_scope()) +
			",\"discarded\":" +
			(discarded ? "true" : "false") +
			"}"
		);
	}

	void send_applied_event(
		const patch_plan &plan,
		const std::string &request_id
	) {
		send_event(
			"{\"type\":\"maxforge.applied\",\"requestId\":" +
			json_string(request_id) +
			",\"patcherId\":" +
			json_string(configured_patcher_id()) +
			",\"scope\":" +
			json_string(plan.scope) +
			",\"revision\":\"" +
			plan.target_revision +
			"\",\"operations\":" +
			std::to_string(plan.operations.size()) +
			"}"
		);
	}

	void send_revision_event(const std::string &revision) {
		send_event(
			"{\"type\":\"maxforge.revision\",\"patcherId\":" +
			json_string(configured_patcher_id()) +
			",\"scope\":" +
			json_string(configured_scope()) +
			",\"revision\":" +
			(revision.empty() ? "null" : "\"" + revision + "\"") +
			"}"
		);
	}

	auto send_event(const std::string &json) -> bool {
		status_output.send("event", json);
		if(!transport_open_) return false;
		if(websocket_client_.send(json)) return true;
		report_transport_error("could not send event to maxforge MCP bridge");
		return false;
	}
};

MIN_EXTERNAL(maxforge_sync);
