fn main() {
    if let Err(error) = gif_p_lib::compression_research::run_cli(std::env::args().skip(1)) {
        eprintln!("GIFP compression research failed: {error}");
        std::process::exit(1);
    }
}
