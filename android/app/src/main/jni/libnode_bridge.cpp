// [xihanzu-NR]
#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#define LOG_TAG "ZapNodeRunner"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" int _ZN4node5StartEiPPc(int argc, char *argv[]);

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;
static volatile int redirects_started = 0;

static void* stdout_logger(void*) {
    ssize_t n;
    char buf[1024];
    while ((n = read(pipe_stdout[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') buf[n - 1] = '\0';
        else buf[n] = '\0';
        LOGI("[Node stdout] %s", buf);
    }
    return nullptr;
}

static void* stderr_logger(void*) {
    ssize_t n;
    char buf[1024];
    while ((n = read(pipe_stderr[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') buf[n - 1] = '\0';
        else buf[n] = '\0';
        LOGE("[Node stderr] %s", buf);
    }
    return nullptr;
}

static void start_log_redirect() {
    if (redirects_started) return;
    redirects_started = 1;

    setvbuf(stdout, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    pthread_create(&thread_stdout, nullptr, stdout_logger, nullptr);
    pthread_detach(thread_stdout);

    pthread_create(&thread_stderr, nullptr, stderr_logger, nullptr);
    pthread_detach(thread_stderr);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_hxdev_zapapp_NodeRunner_startNodeWithArguments(
    JNIEnv *env,
    jclass,
    jobjectArray arguments) {

    start_log_redirect();

    jsize argument_count = env->GetArrayLength(arguments);
    if (argument_count <= 0) return -1;

    // libuv requires all argv strings to be in one contiguous memory buffer
    int total_bytes = 0;
    for (int i = 0; i < argument_count; i++) {
        jstring n_arg = (jstring)env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(n_arg, nullptr);
        total_bytes += strlen(chars) + 1;
        env->ReleaseStringUTFChars(n_arg, chars);
        env->DeleteLocalRef(n_arg);
    }

    char *args_buffer = (char *)calloc(total_bytes + 1, sizeof(char));
    char **argv = (char **)calloc(argument_count + 1, sizeof(char *));

    char *curr_pos = args_buffer;
    for (int i = 0; i < argument_count; i++) {
        jstring n_arg = (jstring)env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(n_arg, nullptr);
        size_t len = strlen(chars);
        strncpy(curr_pos, chars, len);
        curr_pos[len] = '\0';

        argv[i] = curr_pos;
        curr_pos += len + 1;

        env->ReleaseStringUTFChars(n_arg, chars);
        env->DeleteLocalRef(n_arg);
    }
    argv[argument_count] = nullptr;

    LOGI("Calling node::Start with %d args: %s %s", argument_count, argv[0], argument_count > 1 ? argv[1] : "");
    int exit_code = _ZN4node5StartEiPPc(argument_count, argv);
    LOGI("node::Start exited with code: %d", exit_code);

    free(args_buffer);
    free(argv);
    return exit_code;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_janeasystems_nodejs_mobile_NodeRunner_startNodeWithArguments(
    JNIEnv *env,
    jclass cls,
    jobjectArray arguments) {
    return Java_com_hxdev_zapapp_NodeRunner_startNodeWithArguments(env, cls, arguments);
}
