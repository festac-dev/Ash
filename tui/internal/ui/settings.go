package ui

import (
	"fmt"
	"strconv"

	"ash-tui/internal/api"
)

var settingKeys = []string{
	"max_parallel_jobs",
	"require_hiring_approval",
	"allow_external",
	"diy_first",
	"execution_strategy",
	"quality_requirements",
	"deadline",
	"additional_instructions",
	"preferred_agents",
}

func currentSettingValue(settings *api.Settings, key string) string {
	if settings == nil || settings.Task == nil {
		return ""
	}
	task := settings.Task
	switch key {
	case "max_parallel_jobs":
		return strconv.Itoa(task.MaxParallelJobs)
	case "require_hiring_approval":
		return strconv.FormatBool(task.RequireHiringApproval)
	case "allow_external":
		return strconv.FormatBool(task.AllowExternal)
	case "diy_first":
		return strconv.FormatBool(task.DIYFirst)
	case "execution_strategy":
		return task.ExecutionStrategy
	case "quality_requirements":
		return optionalSetting(task.QualityRequirements)
	case "deadline":
		return optionalSetting(task.Deadline)
	case "additional_instructions":
		return optionalSetting(task.AdditionalInstructions)
	case "preferred_agents":
		return joinCSV(task.PreferredAgents)
	}
	return ""
}

func optionalSetting(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func settingHelp(key string) string {
	switch key {
	case "max_parallel_jobs":
		return "1 to the installation ceiling. Applies to subtasks that are independent."
	case "require_hiring_approval":
		return "true or false. When true, each external hire/award/acceptance needs a typed approval."
	case "allow_external":
		return "true or false. When false, the plan can only contain DIY work."
	case "diy_first":
		return "true or false. Ash may attempt local work before sourcing a vendor."
	case "execution_strategy":
		return "autonomous, plan_then_approve or diy_first. Only before a plan exists."
	case "quality_requirements":
		return "Free text. Included in planning and the hire brief; blank clears it."
	case "deadline":
		return "ISO timestamp or YYYY-MM-DD; use none to clear."
	case "additional_instructions":
		return "Private instructions for planning. Never published to the market; blank clears."
	case "preferred_agents":
		return "Comma-separated agent names, handles or ids."
	}
	return ""
}

func joinCSV(values []string) string {
	result := ""
	for index, value := range values {
		if index > 0 {
			result += ", "
		}
		result += value
	}
	return result
}

func settingDisplay(settings *api.Settings, key string) string {
	value := currentSettingValue(settings, key)
	if value == "" {
		value = "—"
	}
	return fmt.Sprintf("%-28s %s", key, value)
}
