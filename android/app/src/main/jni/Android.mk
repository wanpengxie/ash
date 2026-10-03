# The app process marks itself non-dumpable (see packages/core/native/nodump.c): the agent container runs as the same
# Linux user and must not read this process's memory, which holds the owner's and the phone's tokens.
LOCAL_PATH := $(call my-dir)
include $(CLEAR_VARS)
LOCAL_MODULE := ashnodump
LOCAL_SRC_FILES := ../../../../../packages/core/native/nodump.c
LOCAL_LDFLAGS := -Wl,-z,max-page-size=16384
include $(BUILD_SHARED_LIBRARY)
