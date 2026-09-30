#!/system/bin/sh
# Run only on an isolated emulator. Responds to the test build's loopback port.
toybox nc -s 127.0.0.1 -p 4870 -L sh -c '
    IFS= read -r request || exit 0
    echo "$request" >&2
    length=0
    while IFS= read -r line; do
        line=${line%?}
        [ -z "$line" ] && break
        case "$line" in
            [Cc]ontent-[Ll]ength:*) length=${line#*:}; length=${length# } ;;
        esac
    done
    case "$length" in *[!0-9]*|"") exit 0 ;; esac
    dd bs=1 count="$length" of=/dev/null 2>/dev/null
    printf "HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"id\":\"m\",\"seq\":1}"
'
