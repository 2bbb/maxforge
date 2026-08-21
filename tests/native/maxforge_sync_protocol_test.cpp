#include "maxforge_sync_protocol.hpp"

#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

namespace sync_protocol = maxforge::sync_protocol;

struct test_case {
	std::string name;
	std::function<void()> action;
};

void require(bool condition, const std::string &message) {
	if(!condition) throw std::runtime_error(message);
}

template <typename callable>
void require_throws(
	callable &&action,
	const std::string &expected_message
) {
	try {
		action();
	} catch(const std::exception &exception) {
		const std::string message{exception.what()};
		if(message.find(expected_message) == std::string::npos) {
			throw std::runtime_error(
				"expected error containing \"" + expected_message +
				"\", received \"" + message + "\""
			);
		}
		return;
	}
	throw std::runtime_error(
		"expected error containing \"" + expected_message + "\""
	);
}

auto revision(char character) -> std::string {
	return std::string(64, character);
}

auto create_operation(
	const std::string &variable_name,
	bool creates_subpatcher = false,
	const std::vector<std::string> &target_path = {}
) -> sync_protocol::validation_operation
{
	sync_protocol::validation_operation operation;
	operation.kind = sync_protocol::operation_kind::create;
	operation.target_path = target_path;
	operation.created_variable_name = variable_name;
	operation.creates_subpatcher = creates_subpatcher;
	return operation;
}

auto base_plan() -> sync_protocol::validation_plan {
	return sync_protocol::validation_plan{"default", revision('a'), {}};
}

void test_identifiers() {
	require(sync_protocol::is_valid_scope("default"), "default scope rejected");
	require(sync_protocol::is_valid_scope("_agent_2"), "underscore scope rejected");
	require(!sync_protocol::is_valid_scope(""), "empty scope accepted");
	require(!sync_protocol::is_valid_scope("2agent"), "numeric scope accepted");
	require(!sync_protocol::is_valid_scope("agent-live"), "hyphenated scope accepted");

	require(sync_protocol::is_valid_patcher_id("main-patch"), "patcher id rejected");
	require(sync_protocol::is_valid_patcher_id("_main_2"), "underscore id rejected");
	require(!sync_protocol::is_valid_patcher_id("2-main"), "numeric patcher id accepted");
	require(!sync_protocol::is_valid_patcher_id("main patch"), "spaced patcher id accepted");

	require(sync_protocol::is_valid_box_id("obj-osc_1"), "managed id rejected");
	require(!sync_protocol::is_valid_box_id("osc_1"), "unprefixed managed id accepted");
	require(!sync_protocol::is_valid_box_id("obj-"), "empty managed id suffix accepted");
	require(!sync_protocol::is_valid_box_id("obj-osc-1"), "hyphenated suffix accepted");
}

void test_edit_observation_causes() {
	using cause = sync_protocol::edit_observation_cause;
	require(
		sync_protocol::edit_observation_cause_from_registration(
			"patchernotify",
			"dirty"
		) == cause::patcher,
		"patcher notification was misclassified"
	);
	require(
		sync_protocol::edit_observation_cause_from_registration(
			"boxnotify",
			"patching_rect"
		) == cause::box,
		"box notification was misclassified"
	);
	require(
		sync_protocol::edit_observation_cause_from_registration(
			"linenotify",
			"newobject"
		) == cause::line,
		"line notification was misclassified"
	);
	require(
		sync_protocol::edit_observation_cause_from_registration(
			"nobox",
			"attr_modified"
		) == cause::attribute,
		"attribute notification was misclassified"
	);
	require(
		std::string{sync_protocol::edit_observation_cause_name(cause::unknown)} ==
			"unknown",
		"unknown cause name changed"
	);
}

void test_network_configuration() {
	require(sync_protocol::is_loopback_host("127.0.0.1"), "IPv4 loopback rejected");
	require(sync_protocol::is_loopback_host("::1"), "IPv6 loopback rejected");
	require(!sync_protocol::is_loopback_host("localhost"), "hostname treated as loopback");
	require(sync_protocol::is_valid_network_host("192.168.1.20"), "LAN IPv4 rejected");
	require(sync_protocol::is_valid_network_host("agent.local"), "LAN hostname rejected");
	require(sync_protocol::is_valid_network_host("fe80::1"), "LAN IPv6 rejected");
	require(!sync_protocol::is_valid_network_host(""), "empty host accepted");
	require(!sync_protocol::is_valid_network_host("host/path"), "host path accepted");

	require(
		sync_protocol::is_valid_auth_token("studio-session_1~dev"),
		"URL-safe token rejected"
	);
	require(!sync_protocol::is_valid_auth_token(""), "empty token accepted");
	require(!sync_protocol::is_valid_auth_token("contains spaces"), "spaced token accepted");
	require(!sync_protocol::is_valid_auth_token("token/slash"), "slash token accepted");
	require(
		!sync_protocol::is_valid_auth_token(std::string(257, 'a')),
		"oversized token accepted"
	);
	require(
		sync_protocol::has_maxpat_extension("/tmp/voices.maxpat"),
		".maxpat path rejected"
	);
	require(
		sync_protocol::has_maxpat_extension("C:\\patches\\VOICES.MAXPAT"),
		"case-insensitive .maxpat path rejected"
	);
	require(
		!sync_protocol::has_maxpat_extension("/tmp/voices.maxpat.json"),
		"non-.maxpat path accepted"
	);
}

void test_save_completion() {
	using state = sync_protocol::save_completion_state;
	require(
		sync_protocol::evaluate_save_completion(false, true, true, false) ==
			state::succeeded,
		"clean patch at the requested path did not complete"
	);
	require(
		sync_protocol::evaluate_save_completion(true, true, true, false) ==
			state::pending,
		"dirty patch completed"
	);
	require(
		sync_protocol::evaluate_save_completion(false, false, true, false) ==
			state::pending,
		"patch without a filepath completed"
	);
	require(
		sync_protocol::evaluate_save_completion(false, true, false, false) ==
			state::pending,
		"save-as completed at the previous destination"
	);
	require(
		sync_protocol::evaluate_save_completion(false, true, false, true) ==
			state::timed_out,
		"wrong destination did not time out"
	);
	require(
		sync_protocol::evaluate_save_completion(false, true, true, true) ==
			state::succeeded,
		"completion at the deadline was discarded"
	);
}

void test_safe_set_attributes() {
	require(sync_protocol::is_safe_set_attribute("patching_rect"), "position rejected");
	require(sync_protocol::is_safe_set_attribute("presentation_rect"), "presentation rejected");
	require(sync_protocol::is_safe_set_attribute("textcolor"), "color rejected");
	require(sync_protocol::is_safe_set_attribute("_private_style"), "underscore rejected");
	require(!sync_protocol::is_safe_set_attribute(""), "empty attribute accepted");
	require(!sync_protocol::is_safe_set_attribute("2color"), "numeric prefix accepted");
	require(!sync_protocol::is_safe_set_attribute("patching rect"), "spaced attribute accepted");
	require(!sync_protocol::is_safe_set_attribute("maxclass"), "class mutation accepted");
	require(!sync_protocol::is_safe_set_attribute("varname"), "identity mutation accepted");
	require(!sync_protocol::is_safe_set_attribute("patcher"), "patcher mutation accepted");
	require(!sync_protocol::is_safe_set_attribute("filename"), "file mutation accepted");
}

void test_managed_identity() {
	const auto variable_name = sync_protocol::expected_variable_name(
		"voice",
		"obj-osc_1"
	);
	require(
		variable_name == "maxforge_voice_obj_osc_1",
		"unexpected managed variable name"
	);
	require(
		sync_protocol::managed_id_from_variable_name("voice", variable_name) ==
			"obj-osc_1",
		"managed identity did not round-trip"
	);
	require(
		sync_protocol::managed_id_from_variable_name("other", variable_name).empty(),
		"foreign scope was accepted"
	);

	sync_protocol::validate_identity("voice", "obj-osc_1", variable_name);
	require_throws(
		[] {
			sync_protocol::validate_identity("voice", "osc", "maxforge_voice_obj_osc");
		},
		"invalid managed box id"
	);
	require_throws(
		[] {
			sync_protocol::validate_identity("voice", "obj-osc", "wrong");
		},
		"managed box identity mismatch"
	);
}

void test_revisions_paths_and_subpatchers() {
	require(sync_protocol::is_revision(revision('0')), "zero revision rejected");
	require(sync_protocol::is_revision(revision('f')), "hex revision rejected");
	require(!sync_protocol::is_revision(revision('A')), "uppercase revision accepted");
	require(!sync_protocol::is_revision(std::string(63, 'a')), "short revision accepted");
	require(!sync_protocol::is_revision(std::string(64, 'g')), "non-hex revision accepted");
	require(sync_protocol::is_structure_token(std::string(16, 'a')), "structure token rejected");
	require(!sync_protocol::is_structure_token(std::string(15, 'a')), "short structure token accepted");
	require(!sync_protocol::is_structure_token(std::string(16, 'G')), "invalid structure token accepted");
	const auto empty_token = sync_protocol::structure_token("");
	require(empty_token == "cbf29ce484222325", "empty FNV-1a token mismatch");
	require(sync_protocol::is_structure_token(empty_token), "generated token is invalid");
	require(
		sync_protocol::structure_token("{\"boxes\":[],\"connections\":[]}") ==
			"84ba46f66327d22f",
		"canonical structure token mismatch"
	);
	require(
		sync_protocol::structure_token("a") != sync_protocol::structure_token("b"),
		"different structures produced the same fixture token"
	);
	sync_protocol::validate_structure_token(
		sync_protocol::structure_token("current"),
		"current"
	);
	require_throws(
		[] {
			sync_protocol::validate_structure_token(
				sync_protocol::structure_token("inspected"),
				"edited"
			);
		},
		"live patch structure changed since inspection"
	);

	const std::vector<std::string> path{"maxforge_default_obj_group", "inner"};
	require(
		sync_protocol::path_key(path) == "maxforge_default_obj_group/inner",
		"path key mismatch"
	);
	require(
		sync_protocol::child_path_key(path, "child") ==
			"maxforge_default_obj_group/inner/child",
		"child path key mismatch"
	);

	require(sync_protocol::text_creates_subpatcher("newobj", "p voices"), "p rejected");
	require(
		sync_protocol::text_creates_subpatcher("newobj", "patcher voices"),
		"patcher rejected"
	);
	require(
		!sync_protocol::text_creates_subpatcher("message", "p voices"),
		"message treated as subpatcher"
	);
	require(
		!sync_protocol::text_creates_subpatcher("newobj", "print voices"),
		"print treated as subpatcher"
	);
}

void test_valid_state_transition() {
	auto plan = base_plan();
	const std::string source{"maxforge_default_obj_source"};
	const std::string old_box{"maxforge_default_obj_old"};
	const std::string group{"maxforge_default_obj_group"};
	const std::string oscillator{"maxforge_default_obj_osc"};
	const std::string gain{"maxforge_default_obj_gain"};

	sync_protocol::validation_operation disconnect;
	disconnect.kind = sync_protocol::operation_kind::disconnect;
	disconnect.source_variable_name = source;
	disconnect.destination_variable_name = old_box;
	plan.operations.push_back(disconnect);

	sync_protocol::validation_operation delete_operation;
	delete_operation.kind = sync_protocol::operation_kind::delete_box;
	delete_operation.variable_name = old_box;
	plan.operations.push_back(delete_operation);
	plan.operations.push_back(create_operation(group, true));
	plan.operations.push_back(create_operation(oscillator, false, {group}));
	plan.operations.push_back(create_operation(gain, false, {group}));

	sync_protocol::validation_operation set_operation;
	set_operation.kind = sync_protocol::operation_kind::set;
	set_operation.target_path = {group};
	set_operation.variable_name = oscillator;
	plan.operations.push_back(set_operation);

	sync_protocol::validation_operation connect;
	connect.kind = sync_protocol::operation_kind::connect;
	connect.target_path = {group};
	connect.source_variable_name = oscillator;
	connect.destination_variable_name = gain;
	plan.operations.push_back(connect);

	sync_protocol::virtual_patch initial_state{
		{"", {source, old_box}}
	};
	const auto state = sync_protocol::validate_plan(
		plan,
		initial_state,
		"default",
		revision('a')
	);

	require(state.at("").count(source) == 1, "source was removed");
	require(state.at("").count(old_box) == 0, "deleted box remains");
	require(state.at("").count(group) == 1, "subpatcher was not created");
	require(state.at(group).count(oscillator) == 1, "nested oscillator missing");
	require(state.at(group).count(gain) == 1, "nested gain missing");
}

void test_initial_revision_accepts_empty_scope() {
	auto plan = base_plan();
	plan.base_revision = revision('0');
	plan.operations.push_back(create_operation("maxforge_default_obj_first"));
	const auto state = sync_protocol::validate_plan(
		plan,
		{{"", {}}},
		"default",
		""
	);
	require(
		state.at("").count("maxforge_default_obj_first") == 1,
		"initial create failed"
	);
}

void test_empty_plan_can_acknowledge_live_topology() {

	const auto plan = base_plan();
	const sync_protocol::virtual_patch live_state{
		{"", {"maxforge_default_obj_osc", "maxforge_default_obj_gain"}}
	};
	const auto validated_state = sync_protocol::validate_plan(
		plan,
		live_state,
		"default",
		revision('a')
	);
	require(
		validated_state == live_state,
		"empty acknowledgement plan changed live topology"
	);
}

void test_scope_and_revision_guards() {
	const auto plan = base_plan();
	require_throws(
		[&plan] {
			sync_protocol::validate_plan(plan, {{"", {}}}, "other", revision('a'));
		},
		"does not match @scope"
	);
	require_throws(
		[&plan] {
			sync_protocol::validate_plan(
				plan,
				{{"", {"maxforge_default_obj_existing"}}},
				"default",
				""
			);
		},
		"revision state is empty"
	);
	require_throws(
		[&plan] {
			sync_protocol::validate_plan(plan, {{"", {}}}, "default", revision('b'));
		},
		"base revision does not match"
	);
}

void test_operation_order_guard() {
	auto plan = base_plan();
	plan.operations.push_back(create_operation("maxforge_default_obj_new"));
	sync_protocol::validation_operation delete_operation;
	delete_operation.kind = sync_protocol::operation_kind::delete_box;
	delete_operation.variable_name = "maxforge_default_obj_old";
	plan.operations.push_back(delete_operation);

	require_throws(
		[&plan] {
			sync_protocol::validate_plan(
				plan,
				{{"", {"maxforge_default_obj_old"}}},
				"default",
				revision('a')
			);
		},
		"out of protocol order"
	);
}

void test_missing_target_and_endpoint_guards() {
	auto nested_plan = base_plan();
	nested_plan.operations.push_back(create_operation(
		"maxforge_default_obj_child",
		false,
		{"maxforge_default_obj_missing"}
	));
	require_throws(
		[&nested_plan] {
			sync_protocol::validate_plan(
				nested_plan,
				{{"", {}}},
				"default",
				revision('a')
			);
		},
		"target patcher does not exist"
	);

	auto connect_plan = base_plan();
	sync_protocol::validation_operation connect;
	connect.kind = sync_protocol::operation_kind::connect;
	connect.source_variable_name = "maxforge_default_obj_source";
	connect.destination_variable_name = "maxforge_default_obj_missing";
	connect_plan.operations.push_back(connect);
	require_throws(
		[&connect_plan] {
			sync_protocol::validate_plan(
				connect_plan,
				{{"", {"maxforge_default_obj_source"}}},
				"default",
				revision('a')
			);
		},
		"managed box does not exist"
	);
}

void test_duplicate_create_guard() {
	auto plan = base_plan();
	plan.operations.push_back(create_operation("maxforge_default_obj_existing"));
	require_throws(
		[&plan] {
			sync_protocol::validate_plan(
				plan,
				{{"", {"maxforge_default_obj_existing"}}},
				"default",
				revision('a')
			);
		},
		"managed box already exists"
	);
}

void test_delete_removes_descendants() {
	auto plan = base_plan();
	sync_protocol::validation_operation delete_operation;
	delete_operation.kind = sync_protocol::operation_kind::delete_box;
	delete_operation.variable_name = "maxforge_default_obj_group";
	plan.operations.push_back(delete_operation);

	const auto state = sync_protocol::validate_plan(
		plan,
		{
			{"", {"maxforge_default_obj_group"}},
			{"maxforge_default_obj_group", {"maxforge_default_obj_child"}},
			{
				"maxforge_default_obj_group/maxforge_default_obj_child",
				{"maxforge_default_obj_nested"}
			}
		},
		"default",
		revision('a')
	);
	require(state.at("").empty(), "deleted root box remains");
	require(state.count("maxforge_default_obj_group") == 0, "child patch remains");
	require(
		state.count("maxforge_default_obj_group/maxforge_default_obj_child") == 0,
		"nested child patch remains"
	);
}

void test_plain_object_does_not_create_child_patcher() {
	auto plan = base_plan();
	const std::string group{"maxforge_default_obj_group"};
	plan.operations.push_back(create_operation(group));
	plan.operations.push_back(create_operation(
		"maxforge_default_obj_child",
		false,
		{group}
	));
	require_throws(
		[&plan] {
			sync_protocol::validate_plan(
				plan,
				{{"", {}}},
				"default",
				revision('a')
			);
		},
		"target patcher does not exist"
	);
}

void test_reverse_plan_restores_topology() {
	auto forward = base_plan();
	sync_protocol::validation_operation remove_old;
	remove_old.kind = sync_protocol::operation_kind::delete_box;
	remove_old.variable_name = "maxforge_default_obj_old";
	forward.operations.push_back(remove_old);
	forward.operations.push_back(create_operation("maxforge_default_obj_new"));

	const sync_protocol::virtual_patch initial_state{
		{"", {"maxforge_default_obj_old"}}
	};
	const auto target_state = sync_protocol::validate_plan(
		forward,
		initial_state,
		"default",
		revision('a')
	);

	auto reverse = base_plan();
	reverse.base_revision = revision('b');
	sync_protocol::validation_operation remove_new;
	remove_new.kind = sync_protocol::operation_kind::delete_box;
	remove_new.variable_name = "maxforge_default_obj_new";
	reverse.operations.push_back(remove_new);
	reverse.operations.push_back(create_operation("maxforge_default_obj_old"));
	const auto restored_state = sync_protocol::validate_plan(
		reverse,
		target_state,
		"default",
		revision('b')
	);

	require(restored_state == initial_state, "reverse plan did not restore topology");
}

void test_topology_comparison_ignores_empty_child_patchers() {
	const sync_protocol::virtual_patch inspected_state{
		{"", {"maxforge_default_obj_panel"}},
		{"maxforge_default_obj_panel", {}}
	};
	const sync_protocol::virtual_patch restored_state{
		{"", {"maxforge_default_obj_panel"}}
	};
	require(
		sync_protocol::same_managed_box_topology(inspected_state, restored_state),
		"empty child patcher changed managed box topology"
	);

	const sync_protocol::virtual_patch missing_nested_box{
		{"", {"maxforge_default_obj_panel"}},
		{"maxforge_default_obj_panel", {"maxforge_default_obj_nested"}}
	};
	require(
		!sync_protocol::same_managed_box_topology(
			missing_nested_box,
			restored_state
		),
		"non-empty child patcher difference was ignored"
	);
}

}

int main() {
	const std::vector<test_case> test_cases{
		{"identifiers", test_identifiers},
		{"edit observation causes", test_edit_observation_causes},
		{"network configuration", test_network_configuration},
		{"save completion", test_save_completion},
		{"safe set attributes", test_safe_set_attributes},
		{"managed identity", test_managed_identity},
		{"revisions, paths, and subpatchers", test_revisions_paths_and_subpatchers},
		{"valid state transition", test_valid_state_transition},
		{"initial revision", test_initial_revision_accepts_empty_scope},
		{"empty acknowledgement plan", test_empty_plan_can_acknowledge_live_topology},
		{"scope and revision guards", test_scope_and_revision_guards},
		{"operation order", test_operation_order_guard},
		{"missing target and endpoint", test_missing_target_and_endpoint_guards},
		{"duplicate create", test_duplicate_create_guard},
		{"delete descendants", test_delete_removes_descendants},
		{"plain object child patcher", test_plain_object_does_not_create_child_patcher},
		{"reverse plan topology", test_reverse_plan_restores_topology},
		{"empty child patcher topology", test_topology_comparison_ignores_empty_child_patchers}
	};

	std::size_t failure_count{};
	for(const auto &test : test_cases) {
		try {
			test.action();
			std::cout << "PASS: " << test.name << '\n';
		} catch(const std::exception &exception) {
			failure_count++;
			std::cerr << "FAIL: " << test.name << ": " << exception.what() << '\n';
		}
	}

	if(0 < failure_count) {
		std::cerr << failure_count << " test case(s) failed\n";
		return 1;
	}
	std::cout << test_cases.size() << " test cases passed\n";
	return 0;
}
