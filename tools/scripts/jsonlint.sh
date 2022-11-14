#!/usr/bin/env bash

#
# Script modified from
# https://github.com/CICDToolbox/json-lint/blob/master/LICENSE.md
#

# -------------------------------------------------------------------------------- #
# Description                                                                      #
# -------------------------------------------------------------------------------- #
# This script will locate and process all relevant files within the given git      #
# repository. Errors will be stored and a final exit status used to show if a      #
# failure occured during the processing.                                           #
# -------------------------------------------------------------------------------- #

# -------------------------------------------------------------------------------- #
# Configure the shell.                                                             #
# -------------------------------------------------------------------------------- #

set -Eeuo pipefail

# -------------------------------------------------------------------------------- #
# Global Variables                                                                 #
# -------------------------------------------------------------------------------- #
# INSTALL_COMMAND - The command to execute to do the install.                      #
# TEST_COMMAND - The command to execute to perform the test.                       #
# FILE_TYPE_SEARCH_PATTERN - The pattern used to match file types.                 #
# FILE_NAME_SEARCH_PATTERN - The pattern used to match file names.                 #
# EXIT_VALUE - Used to store the script exit value - adjusted by the fail().       #
# CURRENT_STAGE - The current stage used for the reporting output.                 #
# -------------------------------------------------------------------------------- #

INSTALL_COMMAND="npm install jsonlint -g"

TEST_COMMAND='jsonlint'
FILE_TYPE_SEARCH_PATTERN='^JSON'
FILE_NAME_SEARCH_PATTERN='\.json$'

EXIT_VALUE=0
CURRENT_STAGE=0

# -------------------------------------------------------------------------------- #
# Install                                                                          #
# -------------------------------------------------------------------------------- #
# Install the required tooling.                                                    #
# -------------------------------------------------------------------------------- #

function install_prerequisites
{
    stage "Install Prerequisites"

    if ! command -v ${TEST_COMMAND} &> /dev/null
    then
        if errors=$( ${INSTALL_COMMAND} 2>&1 ); then
            success "${INSTALL_COMMAND}"
        else
            fail "${INSTALL_COMMAND}" "${errors}" true
            exit $EXIT_VALUE
        fi
    else
        success "${TEST_COMMAND} is alredy installed"
    fi
}

# -------------------------------------------------------------------------------- #
# Get Version Information                                                          #
# -------------------------------------------------------------------------------- #
# Get the current version of the required tool.                                    #
# -------------------------------------------------------------------------------- #

# function get_version_information
# {
#     VERSION=$("${TEST_COMMAND}" --version | sed 's/[^0-9.]*\([0-9.]*\).*/\1/')
#     BANNER="Run ${TEST_COMMAND} (v${VERSION})"
# }

# -------------------------------------------------------------------------------- #
# Validate JSON                                                                    #
# -------------------------------------------------------------------------------- #
# Use jq to check if a given string represents a valid JSON string.                #
# -------------------------------------------------------------------------------- #

function validate_json()
{
    json_string=$1

    if errors=$(echo "${json_string}" | "${TEST_COMMAND}"); then
        return 0
    fi
    echo "${errors}"
    return 1
}

# -------------------------------------------------------------------------------- #
# Validate JSON from file                                                          #
# -------------------------------------------------------------------------------- #
# A wrapper allowing the user to load a json string from a file and pass it to the #
# validate_json function.                                                          #
# -------------------------------------------------------------------------------- #

function validate_json_from_file()
{
    filename=${1:-}

    raw_json=$(<"${filename}")

    if errors=$(validate_json "${raw_json}"); then
        echo "JSON appears to be valid"
        return 0
    fi

    echo "${errors}"
    return 1
}

# -------------------------------------------------------------------------------- #
# Is Excluded                                                                      #
# -------------------------------------------------------------------------------- #
# Check to see if the filename is in the exclude_list.                             #
# -------------------------------------------------------------------------------- #

function is_excluded()
{
    local needle=$1

    for i in "${exclude_list[@]}"; do
        if [[ "${needle}" =~ ${i} ]]; then
            return 0
        fi
    done
    return 1
}


# -------------------------------------------------------------------------------- #
# Check                                                                            #
# -------------------------------------------------------------------------------- #
# Check a specific file.                                                           #
# -------------------------------------------------------------------------------- #

function check()
{
    local filename="$1"
    local errors

    if is_excluded "${filename}"; then
        skip "${filename}"
        skip_count=$((skip_count+1))
    else
        file_count=$((file_count+1))

        if errors=$( validate_json_from_file "${filename}" 2>&1 ); then
            success "${filename}"
            ok_count=$((ok_count+1))
        else
            fail "${filename}" "${errors}"
            fail_count=$((fail_count+1))
        fi
    fi
}

# -------------------------------------------------------------------------------- #
# Scan Files                                                                       #
# -------------------------------------------------------------------------------- #
# Locate all of the relevant files within the repo and process compatible ones.    #
# -------------------------------------------------------------------------------- #

function scan_files()
{
    while IFS= read -r filename
    do
        if file -b "${filename}" | grep -qE "${FILE_TYPE_SEARCH_PATTERN}"; then
            check "${filename}"
        elif [[ "${filename}" =~ ${FILE_NAME_SEARCH_PATTERN} ]]; then
            check "${filename}"
        fi
    done < <(find . -type f -not -path "./.git/*" | sed 's|^./||' | sort -Vf)
}

# -------------------------------------------------------------------------------- #
# Handle Parameters                                                                #
# -------------------------------------------------------------------------------- #
# Handle any parameters from the pipeline.                                         #
# -------------------------------------------------------------------------------- #

function handle_parameters
{
    local parameters=false

    stage "Parameters"

    if [[ -n "${REPORT_ONLY-}" ]] && [[ "${REPORT_ONLY}" = true ]]; then
        REPORT_ONLY=true
        echo " Report Only: true"
        parameters=true
    else
        REPORT_ONLY=false
    fi

    if [[ -n "${SHOW_ERRORS-}" ]] && [[ "${SHOW_ERRORS}" = false ]]; then
        SHOW_ERRORS=false
        echo " Show Errors: false"
        parameters=true
    else
        SHOW_ERRORS=true
    fi

    if [[ -n "${SHOW_SKIPPED-}" ]] && [[ "${SHOW_SKIPPED}" = true ]]; then
        SHOW_SKIPPED=true
        echo " Show skipped: false"
        parameters=true
    else
        SHOW_SKIPPED=false
    fi

    if [[ -n "${EXCLUDE_FILES-}" ]]; then
        IFS=',' read -r -a exclude_list <<< "${EXCLUDE_FILES}"
        echo " Excluded: ${EXCLUDE_FILES}"
        parameters=true
    else
        # shellcheck disable=SC2034
        declare -a exclude_list=()
    fi

    if [[ "${parameters}" != true ]]; then
        echo " No parameters given"
    fi
}

# -------------------------------------------------------------------------------- #
# Success                                                                          #
# -------------------------------------------------------------------------------- #
# Show the user that the processing of a specific file was successful.             #
# -------------------------------------------------------------------------------- #

function success()
{
    local message="${1:-}"

    if [[ -n "${message}" ]]; then
        printf ' [  %s%sOK%s  ] %s\n' "${bold}" "${success}" "${normal}" "${message}"
    fi
}

# -------------------------------------------------------------------------------- #
# Fail                                                                             #
# -------------------------------------------------------------------------------- #
# Show the user that the processing of a specific file failed and adjust the       #
# EXIT_VALUE to record this.                                                       #
# -------------------------------------------------------------------------------- #

function fail()
{
    local message="${1:-}"
    local errors="${2:-}"
    local override="${3:-}"

    if [[ -n "${message}" ]]; then
        printf ' [ %s%sFAIL%s ] %s\n' "${bold}" "${error}" "${normal}" "${message}"
    fi

    if [[ "${SHOW_ERRORS}" == true ]] || [[ "${override}" == true ]] ; then
        if [[ -n "${errors}" ]]; then
            echo
            mapfile -t error_array <<< "${errors}"
            for err in "${error_array[@]}"
            do
                echo -e "          ${err}"
            done
            echo
        fi
    fi

    EXIT_VALUE=1
}

# -------------------------------------------------------------------------------- #
# Skip                                                                             #
# -------------------------------------------------------------------------------- #
# Show the user that the processing of a specific file was skipped.                #
# -------------------------------------------------------------------------------- #

function skip()
{
    local message="${1:-}"

    if [[ "${SHOW_SKIPPED}" == true ]]; then
        file_count=$((file_count+1))
        if [[ -n "${message}" ]]; then
            printf ' [ %s%sSkip%s ] Skipping %s\n' "${bold}" "${skipped}" "${normal}" "${message}"
        fi
    fi
}

# -------------------------------------------------------------------------------- #
# Draw Line                                                                        #
# -------------------------------------------------------------------------------- #
# Draw a line on the screen. Part of the report generation.                        #
# -------------------------------------------------------------------------------- #

function draw_line
{
    printf '%*s\n' "${screen_width}" '' | tr ' ' -
}

# -------------------------------------------------------------------------------- #
# Align Right                                                                      #
# -------------------------------------------------------------------------------- #
# Draw text alined to the right hand side of the screen.                           #
# -------------------------------------------------------------------------------- #

function align_right()
{
    local message="${1:-}"
    local offset="${2:-2}"
    local width=$screen_width

    local textsize=${#message}
    local left_line='-' left_width=$(( width - (textsize + offset + 2) ))
    local right_line='-' right_width=${offset}

    while ((${#left_line} < left_width)); do left_line+="$left_line"; done
    while ((${#right_line} < right_width)); do right_line+="$right_line"; done

    printf '%s %s %s\n' "${left_line:0:left_width}" "${1}" "${right_line:0:right_width}"
}

# -------------------------------------------------------------------------------- #
# Stage                                                                            #
# -------------------------------------------------------------------------------- #
# Set the current stage number and display the message.                            #
# -------------------------------------------------------------------------------- #

function stage()
{
    message=${1:-}

    CURRENT_STAGE=$((CURRENT_STAGE + 1))

    align_right "Stage ${CURRENT_STAGE} - ${message}"
}

# -------------------------------------------------------------------------------- #
# Draw the report footer on the screen. Part of the report generation.             #
# -------------------------------------------------------------------------------- #

function footer
{
    stage "Report"
    printf ' Total: %s, %sOK%s: %s, %sFailed%s: %s, %sSkipped%s: %s\n' "${file_count}" "${success}" "${normal}" "${ok_count}" "${error}" "${normal}" "${fail_count}" "${skipped}" "${normal}" "${skip_count}"
    stage 'Complete'
}

# -------------------------------------------------------------------------------- #
# Setup                                                                            #
# -------------------------------------------------------------------------------- #
# Handle any custom setup that is required.                                        #
# -------------------------------------------------------------------------------- #

function setup
{
    export TERM=xterm

    screen_width=98
    bold="$(tput bold)"
    normal="$(tput sgr0)"
    error="$(tput setaf 1)"
    success="$(tput setaf 2)"
    skipped="$(tput setaf 6)"

    file_count=0
    ok_count=0
    fail_count=0
    skip_count=0
}

# -------------------------------------------------------------------------------- #
# Main()                                                                           #
# -------------------------------------------------------------------------------- #
# This is the actual 'script' and the functions/sub routines are called in order.  #
# -------------------------------------------------------------------------------- #

setup
handle_parameters
install_prerequisites
# get_version_information
# stage "${BANNER}"
scan_files
footer

if [[ "${REPORT_ONLY}" == true ]]; then
    EXIT_VALUE=0
fi

exit $EXIT_VALUE

# -------------------------------------------------------------------------------- #
# End of Script                                                                    #
# -------------------------------------------------------------------------------- #
# This is the end - nothing more to see here.                                      #
# -------------------------------------------------------------------------------- #
